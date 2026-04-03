/**
 * Claude Code CLI engine executor.
 *
 * Spawns `claude -p <prompt> --output-format stream-json` as a child process,
 * parses JSONL events for assistant text, file changes, session IDs.
 * Multi-turn conversations use `--resume <sessionId>`.
 * Supports OpenRouter as API provider via ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY.
 */

import { existsSync } from "node:fs";
import { relative } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { logger } from "../utils/logger.js";
import { config } from "../config.js";
import { recordClaudeExecution } from "../utils/metrics.js";
import { snapshotDir, diffSnapshots } from "./file-snapshot.js";
import { CLAUDE_MODELS } from "./model-catalog.js";
import type { EngineExecutor, EngineExecOptions, EngineExecResult } from "./types.js";

// ─── Running process tracking ─────────────────────────────────────────────

interface RunningProcess {
  proc: ChildProcess;
  startedAt: number;
}

const runningProcs = new Map<string, RunningProcess>();

setInterval(() => {
  const now = Date.now();
  const staleMs = config.claude.staleProcessMs;
  for (const [id, entry] of runningProcs) {
    if (now - entry.startedAt > staleMs) {
      logger.warn({ execId: id, elapsedMin: Math.round((now - entry.startedAt) / 60_000) }, "Cleaning up stale Claude process");
      try { entry.proc.kill("SIGTERM"); } catch { /* ignore */ }
      runningProcs.delete(id);
    }
  }
}, 60_000);

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

/** Build environment variables for Claude CLI with OpenRouter provider support. */
function buildClaudeEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env as Record<string, string>, NO_COLOR: "1" };

  if (config.claude.provider === "openrouter") {
    if (config.claude.apiKey) {
      env.ANTHROPIC_API_KEY = config.claude.apiKey;
    }
    if (config.claude.baseUrl) {
      env.ANTHROPIC_BASE_URL = config.claude.baseUrl;
    }
  }

  return env;
}

// ─── Executor implementation ──────────────────────────────────────────────

async function executeClaudeOnce(opts: EngineExecOptions): Promise<EngineExecResult> {
  const model = opts.model || config.claude.model;
  const workDir = opts.workingDir || config.codex.workingDir;
  const timeoutMs = opts.timeoutMs || config.claude.timeoutMs;
  const prompt = buildPromptWithImageRefs(opts.prompt, opts.images, workDir);
  const startTime = Date.now();
  const execId = randomUUID().slice(0, 8);

  if (!existsSync(config.claude.bin)) {
    return {
      success: false,
      output: `❌ Claude Code CLI not found at ${config.claude.bin}. Install with: npm install -g @anthropic-ai/claude-code`,
      exitCode: 1, durationMs: 0, timedOut: false, newFiles: [],
    };
  }

  const beforeSnap = await snapshotDir(workDir);

  const args = [
    "-p", prompt,
    "--output-format", "stream-json",
    "--model", model,
    "--no-color",
    "--verbose",
    "--dangerously-skip-permissions",
  ];
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);

  logger.info(
    { engine: "claude", model, workDir, promptLen: prompt.length, imageCount: opts.images?.length || 0, execId, resume: opts.resumeSessionId || "new" },
    "Starting Claude execution",
  );

  return new Promise<EngineExecResult>((resolve) => {
    let resolved = false;
    let sessionId: string | undefined;
    let resultExitCode = 0;
    const textSegments: string[] = [];
    let currentMessage = "";
    let taskCompleteSummary: string | undefined;
    let lastActivity = Date.now();
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCachedTokens = 0;

    const proc = spawn(config.claude.bin, args, {
      cwd: workDir,
      env: buildClaudeEnv(),
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

      if (totalInputTokens || totalOutputTokens) {
        result.usage = {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          cachedTokens: totalCachedTokens,
        };
      }

      recordClaudeExecution(result.success, result.durationMs, result.timedOut);
      logger.info(
        { execId, engine: "claude", exitCode: result.exitCode, durationMs: result.durationMs, outputLen: result.output.length, newFiles: result.newFiles.length, sessionId: result.sessionId || "none", tokens: { input: totalInputTokens, output: totalOutputTokens, cached: totalCachedTokens } },
        "Claude execution completed",
      );
      resolve(result);
    };

    // Adaptive timeout
    const ACTIVITY_WINDOW_MS = 180_000;
    const EXTEND_MS = 300_000;
    let deadline = Date.now() + timeoutMs;

    const timeoutTimer = setInterval(() => {
      if (resolved) { clearInterval(timeoutTimer); return; }
      const now = Date.now();
      if ((now - lastActivity) < ACTIVITY_WINDOW_MS) { deadline = now + EXTEND_MS; return; }
      if (now > deadline) {
        logger.warn({ execId, elapsed: now - startTime, lastActivityAgo: now - lastActivity }, "Claude timeout");
        finish({
          success: false,
          output: textSegments.join("\n\n").trim() || currentMessage.trim() || "(timed out)",
          exitCode: 1, durationMs: now - startTime, timedOut: true, newFiles: [],
        });
      }
    }, 10_000);

    // JSONL parsing — Claude Code stream-json format
    const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });
    rl.on("line", (line: string) => {
      lastActivity = Date.now();
      if (!line.trim()) return;

      let event: Record<string, unknown>;
      try { event = JSON.parse(line); } catch { return; }

      const fullText = () => {
        const parts = [...textSegments];
        if (currentMessage && !parts.includes(currentMessage)) parts.push(currentMessage);
        return parts.join("\n\n");
      };

      const eventType = event.type as string;

      switch (eventType) {
        // Assistant text streaming
        case "assistant": {
          const msg = event.message as { content?: Array<{ type?: string; text?: string }> } | undefined;
          if (msg?.content) {
            for (const block of msg.content) {
              if (block.type === "text" && block.text) {
                currentMessage = block.text;
                if (!textSegments.includes(block.text)) textSegments.push(block.text);
                opts.onTextEvent?.(block.text, fullText());
              }
            }
          }
          // Extract session ID from event
          if (event.session_id) sessionId = event.session_id as string;
          break;
        }
        case "content_block_delta": {
          const delta = event.delta as { type?: string; text?: string } | undefined;
          if (delta?.type === "text_delta" && delta.text) {
            currentMessage += delta.text;
            opts.onProgress?.(delta.text);
            opts.onTextEvent?.(delta.text, fullText());
          }
          break;
        }
        case "content_block_start": {
          const block = event.content_block as { type?: string; text?: string } | undefined;
          if (block?.type === "text" && block.text) {
            currentMessage += block.text;
          }
          break;
        }
        // Message complete
        case "message_start": {
          const msg = event.message as { id?: string; usage?: { input_tokens?: number; cache_read_input_tokens?: number } } | undefined;
          if (msg?.usage) {
            totalInputTokens += msg.usage.input_tokens || 0;
            totalCachedTokens += msg.usage.cache_read_input_tokens || 0;
          }
          break;
        }
        case "message_delta": {
          const delta = event.delta as { stop_reason?: string } | undefined;
          const usage = event.usage as { output_tokens?: number } | undefined;
          if (usage) totalOutputTokens += usage.output_tokens || 0;
          if (currentMessage && !textSegments.includes(currentMessage)) {
            textSegments.push(currentMessage);
          }
          currentMessage = "";
          break;
        }
        // Tool execution events
        case "tool_use":
        case "tool.execution_start":
          logger.debug({ execId, tool: (event.name as string) || (event.data as { toolName?: string })?.toolName }, "Claude tool started");
          break;
        case "tool.execution_complete": {
          const data = event.data as { toolName?: string; result?: string; success?: boolean } | undefined;
          if (data?.toolName === "task_complete") {
            taskCompleteSummary = data.result || taskCompleteSummary;
          }
          logger.debug({ execId, tool: data?.toolName, success: data?.success }, "Claude tool completed");
          break;
        }
        // Result / session events (Copilot-compatible format that Claude may emit)
        case "result": {
          sessionId = (event.session_id as string) || (event.sessionId as string) || sessionId;
          resultExitCode = (event.exitCode as number) ?? (event.exit_code as number) ?? 0;
          // Result may contain final text
          const resultText = event.result as string | undefined;
          if (resultText && !textSegments.includes(resultText)) {
            textSegments.push(resultText);
          }
          break;
        }
        case "session.task_complete": {
          const data = event.data as { summary?: string } | undefined;
          taskCompleteSummary = data?.summary || taskCompleteSummary;
          break;
        }
        // System/lifecycle events — ignore silently
        case "system": case "session.start": case "session.model_change":
        case "session.mcp_server_status_changed": case "session.mcp_servers_loaded":
        case "session.tools_updated": case "user.message": case "ping":
        case "assistant.reasoning_delta": case "assistant.reasoning":
        case "assistant.turn_start": case "assistant.turn_end":
        case "session.background_tasks_changed":
          break;
        // Copilot-compatible streaming events
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
            if (!textSegments.includes(content)) textSegments.push(content);
            opts.onTextEvent?.(content, fullText());
          }
          break;
        }
        default:
          logger.debug({ execId, type: eventType }, "Unhandled Claude event");
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

export const claudeEngine: EngineExecutor = {
  name: "claude",

  async execute(opts: EngineExecOptions): Promise<EngineExecResult> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= SPAWN_RETRY_LIMIT; attempt++) {
      try {
        return await executeClaudeOnce(opts);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const isSpawn = lastError.message.includes("ENOENT") || lastError.message.includes("spawn") || lastError.message.includes("EAGAIN");
        if (!isSpawn || attempt >= SPAWN_RETRY_LIMIT) break;
        logger.warn({ err: lastError, attempt: attempt + 1 }, "Claude spawn retry");
        await sleep(SPAWN_RETRY_DELAY_MS * (attempt + 1));
      }
    }
    return {
      success: false,
      output: `❌ Claude execution failed: ${lastError?.message}`,
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
    return CLAUDE_MODELS;
  },
};
