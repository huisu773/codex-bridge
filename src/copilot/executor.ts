/**
 * Copilot CLI executor.
 *
 * Spawns `copilot -p <prompt> --output-format json --autopilot --allow-all`
 * as a child process, parses JSONL events for assistant text, file changes,
 * session IDs, and result data.
 *
 * Uses structured JSONL output instead of PTY + TUI parsing for reliability.
 * Multi-turn conversations use `--resume=<sessionId>`.
 */

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { logger } from "../utils/logger.js";
import { config } from "../config.js";
import { recordCopilotExecution } from "../utils/metrics.js";
import type {
  CopilotExecOptions,
  CopilotExecResult,
} from "./types.js";

const execFileAsync = promisify(execFile);

// ─── Default ask_user instruction (overridable via COPILOT_INSTRUCTIONS) ──

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

// ─── Running process tracking ──────────────────────────────────────

interface RunningProcess {
  proc: ChildProcess;
  startedAt: number;
}

const runningProcs = new Map<string, RunningProcess>();

// Periodic cleanup of stale processes (configurable threshold)
setInterval(() => {
  const now = Date.now();
  const staleMs = config.copilot.staleProcessMs;
  for (const [id, entry] of runningProcs) {
    if (now - entry.startedAt > staleMs) {
      logger.warn({ execId: id, elapsedMin: Math.round((now - entry.startedAt) / 60_000) }, "Cleaning up stale Copilot process");
      try {
        entry.proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      runningProcs.delete(id);
    }
  }
}, 60_000);

// ─── Config dir setup ──────────────────────────────────────────────
// Use a STABLE shared config dir so --resume can find previous session data.
// The instructions file is always (re-)written to keep it up to date.

let sharedConfigDir: string | undefined;

function getOrCreateConfigDir(): string {
  if (!sharedConfigDir) {
    sharedConfigDir = config.copilot.configDir;
  }
  mkdirSync(sharedConfigDir, { recursive: true });
  writeFileSync(join(sharedConfigDir, "copilot-instructions.md"), getInstructions());
  return sharedConfigDir;
}

// ─── Directory snapshot for file detection ─────────────────────────

async function snapshotDir(dir: string): Promise<Map<string, number>> {
  const snap = new Map<string, number>();
  try {
    const { stdout } = await execFileAsync("find", [
      dir,
      "-maxdepth", "3",
      "-type", "f",
      "-not", "-path", "*/node_modules/*",
      "-not", "-path", "*/.git/*",
      "-not", "-path", "*/logs/*",
      "-not", "-name", "*.log",
      "-not", "-name", "*.sqlite*",
      "-not", "-name", "*.lock",
      "-not", "-name", "package-lock.json",
      "-not", "-path", "*/dist/*",
      "-not", "-path", "*/.codex/*",
      "-not", "-path", "*/sessions/*",
      "-printf", "%T@ %p\\n",
    ], { encoding: "utf-8", timeout: 5000, maxBuffer: 5 * 1024 * 1024 });
    const lines = stdout.trim().split("\n").filter(Boolean).slice(0, 5000);
    for (const line of lines) {
      const spaceIdx = line.indexOf(" ");
      if (spaceIdx > 0) {
        const mtime = parseFloat(line.slice(0, spaceIdx));
        const path = line.slice(spaceIdx + 1);
        snap.set(path, mtime);
      }
    }
  } catch {
    // Ignore snapshot errors
  }
  return snap;
}

function diffSnapshots(before: Map<string, number>, after: Map<string, number>): string[] {
  const newFiles: string[] = [];
  for (const [path, mtime] of after) {
    const prevMtime = before.get(path);
    if (prevMtime === undefined || mtime > prevMtime) {
      newFiles.push(path);
    }
  }
  return newFiles;
}

// ─── Helpers ───────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Max spawn retries on transient errors
const SPAWN_RETRY_LIMIT = 2;
const SPAWN_RETRY_DELAY_MS = 3000;

// ─── Main executor ─────────────────────────────────────────────────

export async function executeCopilot(
  opts: CopilotExecOptions,
): Promise<CopilotExecResult> {
  // Retry wrapper for transient spawn failures
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= SPAWN_RETRY_LIMIT; attempt++) {
    try {
      return await _executeCopilotOnce(opts);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const isSpawnError = lastError.message.includes("ENOENT") ||
        lastError.message.includes("spawn") ||
        lastError.message.includes("EAGAIN");
      if (!isSpawnError || attempt >= SPAWN_RETRY_LIMIT) break;
      logger.warn({ err: lastError, attempt: attempt + 1 }, "Copilot spawn failed, retrying...");
      await sleep(SPAWN_RETRY_DELAY_MS * (attempt + 1));
    }
  }
  return {
    success: false,
    output: `❌ Copilot execution failed after ${SPAWN_RETRY_LIMIT + 1} attempts: ${lastError?.message}`,
    exitCode: 1,
    durationMs: 0,
    timedOut: false,
    newFiles: [],
    askUserRounds: 0,
  };
}

async function _executeCopilotOnce(
  opts: CopilotExecOptions,
): Promise<CopilotExecResult> {
  const model = opts.model || config.copilot.model;
  const workDir = opts.workingDir || config.codex.workingDir;
  const timeoutMs = opts.timeoutMs || config.copilot.timeoutMs;
  const startTime = Date.now();
  const execId = randomUUID().slice(0, 8);

  // Verify copilot binary exists
  if (!existsSync(config.copilot.bin)) {
    return {
      success: false,
      output: `❌ Copilot CLI not found at ${config.copilot.bin}. Set COPILOT_BIN env var.`,
      exitCode: 1,
      durationMs: 0,
      timedOut: false,
      newFiles: [],
      askUserRounds: 0,
    };
  }

  // Snapshot working directory BEFORE execution for file detection
  const beforeSnap = await snapshotDir(workDir);

  const configDir = getOrCreateConfigDir();

  const args = [
    "-p", opts.prompt,
    "--output-format", "json",
    "--model", model,
    "--config-dir", configDir,
    "--no-color",
  ];

  if (config.copilot.allowAll) {
    args.push("--allow-all");
  }
  if (config.copilot.autopilot) {
    args.push("--autopilot");
  }

  // Multi-turn: pass --resume to continue a previous session
  if (opts.resumeSessionId) {
    args.push("--resume", opts.resumeSessionId);
  }

  logger.info(
    { model, workDir, promptLen: opts.prompt.length, execId, resumeSession: opts.resumeSessionId || "new" },
    "Starting Copilot JSONL execution",
  );

  return new Promise<CopilotExecResult>((resolve) => {
    let resolved = false;
    let sessionId: string | undefined;
    let resultExitCode = 0;
    let askUserRounds = 0;
    const textSegments: string[] = [];
    let currentMessageContent = "";
    let lastActivityTime = Date.now();

    const proc = spawn(config.copilot.bin, args, {
      cwd: workDir,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    runningProcs.set(execId, { proc, startedAt: Date.now() });

    const finish = async (result: CopilotExecResult) => {
      if (resolved) return;
      resolved = true;
      clearInterval(timeoutTimer);
      runningProcs.delete(execId);

      try {
        proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }

      // Detect new/modified files by diffing snapshots
      try {
        const afterSnap = await snapshotDir(workDir);
        result.newFiles = diffSnapshots(beforeSnap, afterSnap);
      } catch {
        // Keep empty if snapshot fails
      }

      // Use sessionId from result event, or preserved resumeSessionId
      if (!result.sessionId) {
        result.sessionId = sessionId || opts.resumeSessionId;
      }

      // Record metrics
      recordCopilotExecution(result.success, result.durationMs, result.timedOut, result.askUserRounds);

      logger.info(
        {
          execId,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          askUserRounds: result.askUserRounds,
          outputLen: result.output.length,
          newFileCount: result.newFiles.length,
          sessionId: result.sessionId || "none",
        },
        "Copilot execution completed",
      );
      resolve(result);
    };

    // ─── Adaptive timeout ────────────────────────────────────
    const ACTIVITY_WINDOW_MS = 60_000;
    const EXTEND_INTERVAL_MS = 120_000;
    let currentDeadline = Date.now() + timeoutMs;

    const timeoutTimer = setInterval(() => {
      if (resolved) {
        clearInterval(timeoutTimer);
        return;
      }
      const now = Date.now();
      const recentlyActive = (now - lastActivityTime) < ACTIVITY_WINDOW_MS;

      if (recentlyActive) {
        currentDeadline = now + EXTEND_INTERVAL_MS;
        return;
      }

      if (now > currentDeadline) {
        logger.warn({ execId, elapsed: now - startTime }, "Copilot adaptive timeout reached");
        const output = textSegments.join("\n\n").trim() || currentMessageContent.trim() || "(timed out)";
        finish({
          success: false,
          output,
          exitCode: 1,
          durationMs: now - startTime,
          timedOut: true,
          newFiles: [],
          askUserRounds,
        });
      }
    }, 5_000);

    // ─── JSONL parsing ───────────────────────────────────────
    const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });

    rl.on("line", (line: string) => {
      lastActivityTime = Date.now();
      if (!line.trim()) return;

      let event: {
        type: string;
        data?: Record<string, unknown>;
        sessionId?: string;
        exitCode?: number;
        usage?: Record<string, unknown>;
      };
      try {
        event = JSON.parse(line);
      } catch {
        logger.debug({ execId, line: line.slice(0, 200) }, "Non-JSON line from Copilot");
        return;
      }

      switch (event.type) {
        case "assistant.message_delta": {
          const delta = (event.data as { deltaContent?: string })?.deltaContent;
          if (delta) {
            currentMessageContent += delta;
            opts.onProgress?.(delta);
            opts.onTextEvent?.(delta, currentMessageContent);
          }
          break;
        }

        case "assistant.message": {
          const content = (event.data as { content?: string })?.content;
          if (content) {
            currentMessageContent = content;
            textSegments.push(content);
            opts.onTextEvent?.(content, textSegments.join("\n\n"));
          }
          break;
        }

        case "assistant.tool_call": {
          const toolName = (event.data as { name?: string })?.name;
          logger.debug({ execId, tool: toolName }, "Copilot tool call");
          if (toolName === "ask_user") {
            askUserRounds++;
          }
          break;
        }

        case "assistant.turn_end": {
          if (currentMessageContent && !textSegments.includes(currentMessageContent)) {
            textSegments.push(currentMessageContent);
          }
          currentMessageContent = "";
          break;
        }

        case "result": {
          sessionId = event.sessionId as string || sessionId;
          resultExitCode = (event.exitCode as number) ?? 0;
          logger.debug(
            { execId, sessionId, exitCode: resultExitCode, usage: event.usage },
            "Copilot result event",
          );
          break;
        }

        // Silently skip known informational events
        case "session.start":
        case "session.model_change":
        case "session.mcp_server_status_changed":
        case "session.mcp_servers_loaded":
        case "session.tools_updated":
        case "user.message":
        case "assistant.reasoning_delta":
        case "assistant.reasoning":
        case "assistant.turn_start":
          break;

        default:
          logger.debug({ execId, type: event.type }, "Unhandled Copilot JSONL event");
      }
    });

    // Capture stderr for error messages
    let stderrBuf = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      lastActivityTime = Date.now();
    });

    // Process exit
    proc.on("close", (code: number | null) => {
      const exitCode = code ?? resultExitCode;
      const output = textSegments.join("\n\n").trim() ||
        currentMessageContent.trim() ||
        (stderrBuf.trim() ? `stderr: ${stderrBuf.trim()}` : "(no output)");
      const durationMs = Date.now() - startTime;

      finish({
        success: exitCode === 0,
        output,
        exitCode,
        durationMs,
        timedOut: false,
        newFiles: [],
        askUserRounds,
        sessionId,
      });
    });

    proc.on("error", (err: Error) => {
      finish({
        success: false,
        output: `Spawn error: ${err.message}`,
        exitCode: 1,
        durationMs: Date.now() - startTime,
        timedOut: false,
        newFiles: [],
        askUserRounds: 0,
      });
    });
  });
}

// ─── Task management ───────────────────────────────────────────────

export function cancelAllCopilotTasks(): number {
  let count = 0;
  for (const [id, entry] of runningProcs) {
    try {
      entry.proc.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    runningProcs.delete(id);
    count++;
  }
  return count;
}

export function getRunningCopilotCount(): number {
  return runningProcs.size;
}
