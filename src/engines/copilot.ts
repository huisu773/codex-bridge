/**
 * Copilot CLI engine executor.
 *
 * Spawns `copilot -p <prompt> --output-format json` as a child process,
 * parses JSONL events for assistant text, file changes, session IDs.
 * Multi-turn conversations use `--resume=<sessionId>`.
 */

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { logger } from "../utils/logger.js";
import { config } from "../config.js";
import { recordCopilotExecution } from "../utils/metrics.js";
import { snapshotDir, diffSnapshots } from "./file-snapshot.js";
import { COPILOT_MODELS } from "./model-catalog.js";
import type { EngineExecutor, EngineExecOptions, EngineExecResult } from "./types.js";

// ─── Default instructions (overridable via COPILOT_INSTRUCTIONS) ──────────

const DEFAULT_INSTRUCTIONS = `# 强制交互协议

## 核心规则：每次回复结束前必须调用 \`ask_user\` 工具

这是不可跳过的强制协议。在你的每一轮回复中，你必须执行以下操作之一：

1. **完成用户请求后** → 立即调用 \`ask_user\` 工具，提出与当前上下文相关的后续问题
2. **存在任何不确定性时** → 不要猜测执行，立即调用 \`ask_user\` 工具进行澄清

## 禁止行为

- **禁止在不调用 \`ask_user\` 的情况下结束回复**
- **禁止使用终结性表达**（如"希望对你有帮助"、"如有问题随时提问"等）
- **禁止猜测用户意图** — 不确定就用 \`ask_user\` 询问

## \`ask_user\` 调用要求

- 问题必须与当前任务上下文直接相关
- 问题必须具体、可操作，不要问泛泛的"还需要什么帮助"
- 可以提供选项供用户选择，降低用户输入成本
`;

function getInstructions(): string {
  return config.copilot.instructions || DEFAULT_INSTRUCTIONS;
}

// ─── Running process tracking ─────────────────────────────────────────────

interface RunningProcess {
  proc: ChildProcess;
  startedAt: number;
}

const runningProcs = new Map<string, RunningProcess>();

setInterval(() => {
  const now = Date.now();
  const staleMs = config.copilot.staleProcessMs;
  for (const [id, entry] of runningProcs) {
    if (now - entry.startedAt > staleMs) {
      logger.warn({ execId: id, elapsedMin: Math.round((now - entry.startedAt) / 60_000) }, "Cleaning up stale Copilot process");
      try { entry.proc.kill("SIGTERM"); } catch { /* ignore */ }
      runningProcs.delete(id);
    }
  }
}, 60_000);

// ─── Shared config dir ────────────────────────────────────────────────────

let sharedConfigDir: string | undefined;

function getOrCreateConfigDir(): string {
  if (!sharedConfigDir) {
    sharedConfigDir = config.copilot.configDir;
  }
  mkdirSync(sharedConfigDir, { recursive: true });
  writeFileSync(join(sharedConfigDir, "copilot-instructions.md"), getInstructions());
  return sharedConfigDir;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const SPAWN_RETRY_LIMIT = 2;
const SPAWN_RETRY_DELAY_MS = 3000;

export function buildPromptWithImageRefs(prompt: string, images: string[] | undefined, workDir: string): string {
  if (!images || images.length === 0) return prompt;
  const refs = images.map((img) => {
    const rel = relative(workDir, img);
    const normalized = rel && !rel.startsWith("..") ? rel : img;
    return `@${normalized}`;
  });
  return `${prompt}\n\nAttached image files:\n${refs.join("\n")}\n\nPlease use these images as visual context.`;
}

// ─── Executor implementation ──────────────────────────────────────────────

async function executeCopilotOnce(opts: EngineExecOptions): Promise<EngineExecResult> {
  const model = opts.model || config.copilot.model;
  const workDir = opts.workingDir || config.codex.workingDir;
  const timeoutMs = opts.timeoutMs || config.copilot.timeoutMs;
  const prompt = buildPromptWithImageRefs(opts.prompt, opts.images, workDir);
  const startTime = Date.now();
  const execId = randomUUID().slice(0, 8);

  if (!existsSync(config.copilot.bin)) {
    return {
      success: false,
      output: `❌ Copilot CLI not found at ${config.copilot.bin}. Set COPILOT_BIN env var.`,
      exitCode: 1, durationMs: 0, timedOut: false, newFiles: [],
    };
  }

  const beforeSnap = await snapshotDir(workDir);
  const configDir = getOrCreateConfigDir();

  const args = [
    "-p", prompt,
    "--output-format", "json",
    "--model", model,
    "--config-dir", configDir,
    "--no-color",
  ];
  if (config.copilot.allowAll) args.push("--allow-all");
  if (config.copilot.autopilot) args.push("--autopilot");
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);

  logger.info(
    { engine: "copilot", model, workDir, promptLen: prompt.length, imageCount: opts.images?.length || 0, execId, resume: opts.resumeSessionId || "new" },
    "Starting Copilot execution",
  );

    return new Promise<EngineExecResult>((resolve) => {
      let resolved = false;
      let sessionId: string | undefined;
      let resultExitCode = 0;
      const textSegments: string[] = [];
      let currentMessage = "";
      let taskCompleteSummary: string | undefined;
      let lastActivity = Date.now();

    const proc = spawn(config.copilot.bin, args, {
      cwd: workDir,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    runningProcs.set(execId, { proc, startedAt: Date.now() });

    const finish = async (result: EngineExecResult) => {
      if (resolved) return;
      resolved = true;
      clearInterval(timeoutTimer);
      runningProcs.delete(execId);
      try { proc.kill("SIGTERM"); } catch { /* ignore */ }

      try {
        const afterSnap = await snapshotDir(workDir);
        result.newFiles = diffSnapshots(beforeSnap, afterSnap);
      } catch { /* keep empty */ }

      if (!result.sessionId) {
        result.sessionId = sessionId || opts.resumeSessionId;
      }

      recordCopilotExecution(result.success, result.durationMs, result.timedOut, 0);
      logger.info(
        { execId, engine: "copilot", exitCode: result.exitCode, durationMs: result.durationMs, outputLen: result.output.length, newFiles: result.newFiles.length, sessionId: result.sessionId || "none" },
        "Copilot execution completed",
      );
      resolve(result);
    };

    // Adaptive timeout — generous windows for complex multi-step tasks.
    // During long tool executions (e.g., shell commands), copilot may emit
    // no JSONL events for extended periods.
    const ACTIVITY_WINDOW_MS = 180_000; // 3 min inactivity before checking deadline
    const EXTEND_MS = 300_000;          // extend deadline by 5 min on activity
    let deadline = Date.now() + timeoutMs;

    const timeoutTimer = setInterval(() => {
      if (resolved) { clearInterval(timeoutTimer); return; }
      const now = Date.now();
      if ((now - lastActivity) < ACTIVITY_WINDOW_MS) { deadline = now + EXTEND_MS; return; }
      if (now > deadline) {
        logger.warn({ execId, elapsed: now - startTime, lastActivityAgo: now - lastActivity }, "Copilot timeout");
        finish({
          success: false,
          output: textSegments.join("\n\n").trim() || currentMessage.trim() || "(timed out)",
          exitCode: 1, durationMs: now - startTime, timedOut: true, newFiles: [],
        });
      }
    }, 10_000);

    // JSONL parsing
    const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });
    rl.on("line", (line: string) => {
      lastActivity = Date.now();
      if (!line.trim()) return;

      let event: { type: string; data?: Record<string, unknown>; sessionId?: string; exitCode?: number; usage?: Record<string, unknown> };
      try { event = JSON.parse(line); } catch { return; }

      const fullText = () => {
        const parts = [...textSegments];
        if (currentMessage && !parts.includes(currentMessage)) parts.push(currentMessage);
        return parts.join("\n\n");
      };

      switch (event.type) {
        case "assistant.message_delta": {
          const delta = (event.data as { deltaContent?: string })?.deltaContent;
          if (delta) {
            currentMessage += delta;
            opts.onProgress?.(delta);
            opts.onTextEvent?.(delta, fullText());
          }
          break;
        }
        case "assistant.message": {
          const content = (event.data as { content?: string })?.content;
          if (content) {
            currentMessage = content;
            textSegments.push(content);
            opts.onTextEvent?.(content, fullText());
          }
          break;
        }
        case "tool.execution_start":
          logger.debug({ execId, tool: (event.data as { toolName?: string })?.toolName }, "Copilot tool started");
          break;
        case "tool.execution_complete": {
          const data = event.data as { toolName?: string; result?: string; success?: boolean };
          if (data?.toolName === "task_complete") {
            const result = data.result as { content?: string; detailedContent?: string } | undefined;
            taskCompleteSummary = result?.content || result?.detailedContent || taskCompleteSummary;
          }
          logger.debug({ execId, tool: data?.toolName, success: data?.success }, "Copilot tool completed");
          break;
        }
        case "assistant.tool_call":
          logger.debug({ execId, tool: (event.data as { name?: string })?.name }, "Copilot tool call");
          break;
        case "assistant.turn_end":
          if (currentMessage && !textSegments.includes(currentMessage)) textSegments.push(currentMessage);
          currentMessage = "";
          break;
        case "result":
          sessionId = (event.sessionId as string) || sessionId;
          resultExitCode = (event.exitCode as number) ?? 0;
          break;
        case "session.task_complete": {
          const data = event.data as { summary?: string } | undefined;
          taskCompleteSummary = data?.summary || taskCompleteSummary;
          break;
        }
        case "session.start": case "session.model_change": case "session.mcp_server_status_changed":
        case "session.mcp_servers_loaded": case "session.tools_updated": case "user.message":
        case "assistant.reasoning_delta": case "assistant.reasoning": case "assistant.turn_start":
        case "session.background_tasks_changed":
          break;
        default:
          logger.debug({ execId, type: event.type }, "Unhandled Copilot event");
      }
    });

    let stderrBuf = "";
    proc.stderr?.on("data", (chunk: Buffer) => { stderrBuf += chunk.toString(); lastActivity = Date.now(); });

    proc.on("close", (code: number | null) => {
      const exitCode = code ?? resultExitCode;
      const assembled = textSegments.join("\n\n").trim() || currentMessage.trim();
      const output = taskCompleteSummary
        ? [assembled, taskCompleteSummary].filter(Boolean).join("\n\n")
        : (assembled || (stderrBuf.trim() ? `stderr: ${stderrBuf.trim()}` : "(no output)"));
      finish({ success: exitCode === 0, output, exitCode, durationMs: Date.now() - startTime, timedOut: false, newFiles: [], sessionId });
    });

    proc.on("error", (err: Error) => {
      finish({ success: false, output: `Spawn error: ${err.message}`, exitCode: 1, durationMs: Date.now() - startTime, timedOut: false, newFiles: [] });
    });
  });
}

// ─── Public EngineExecutor ────────────────────────────────────────────────

export const copilotEngine: EngineExecutor = {
  name: "copilot",

  async execute(opts: EngineExecOptions): Promise<EngineExecResult> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= SPAWN_RETRY_LIMIT; attempt++) {
      try {
        return await executeCopilotOnce(opts);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const isSpawn = lastError.message.includes("ENOENT") || lastError.message.includes("spawn") || lastError.message.includes("EAGAIN");
        if (!isSpawn || attempt >= SPAWN_RETRY_LIMIT) break;
        logger.warn({ err: lastError, attempt: attempt + 1 }, "Copilot spawn retry");
        await sleep(SPAWN_RETRY_DELAY_MS * (attempt + 1));
      }
    }
    return {
      success: false,
      output: `❌ Copilot execution failed: ${lastError?.message}`,
      exitCode: 1, durationMs: 0, timedOut: false, newFiles: [],
    };
  },

  cancelAll(): number {
    let count = 0;
    for (const [id, entry] of runningProcs) {
      try { entry.proc.kill("SIGTERM"); } catch { /* ignore */ }
      runningProcs.delete(id);
      count++;
    }
    return count;
  },

  getRunningCount(): number {
    return runningProcs.size;
  },

  listModels() {
    return COPILOT_MODELS;
  },
};
