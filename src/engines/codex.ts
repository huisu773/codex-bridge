/**
 * Codex CLI engine executor.
 *
 * Spawns `codex exec` with JSONL output, parses events for text, thread IDs,
 * usage statistics, and file changes. Supports multi-turn via `exec resume`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { logger } from "../utils/logger.js";
import { config } from "../config.js";
import { recordCodexExecution } from "../utils/metrics.js";
import { snapshotDir, diffSnapshots } from "./file-snapshot.js";
import type { EngineExecutor, EngineExecOptions, EngineExecResult } from "./types.js";

// ─── Running process tracking ─────────────────────────────────────────────

interface RunningProcess {
  proc: ChildProcess;
  startedAt: number;
}

const runningProcesses = new Map<string, RunningProcess>();

setInterval(() => {
  const now = Date.now();
  const STALE_MS = 24 * 3600_000;
  for (const [id, entry] of runningProcesses) {
    if (now - entry.startedAt > STALE_MS) {
      logger.warn({ execId: id, elapsedMin: Math.round((now - entry.startedAt) / 60_000) }, "Cleaning up stale Codex process");
      try { entry.proc.kill("SIGKILL"); } catch { /* ignore */ }
      runningProcesses.delete(id);
    }
  }
}, 300_000);

// ─── Executor implementation ──────────────────────────────────────────────

function executeCodexOnce(opts: EngineExecOptions): Promise<EngineExecResult> {
  const model = opts.model || config.codex.model;
  const workDir = opts.workingDir || config.codex.workingDir;
  const baseTimeout = opts.timeoutMs || config.codex.timeoutMs;
  const EXTEND_INTERVAL = 120_000;

  return new Promise(async (resolve) => {
    const beforeSnap = await snapshotDir(workDir);
    const outputFile = join(tmpdir(), `codex-out-${randomUUID().slice(0, 8)}.txt`);
    const start = Date.now();
    const execId = randomUUID().slice(0, 8);

    let args: string[];
    if (opts.resumeSessionId) {
      args = [
        "exec", "resume", opts.resumeSessionId,
        "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check",
        "-m", model, "-o", outputFile, "--json", opts.prompt,
      ];
    } else {
      args = [
        "exec",
        "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check",
        "-m", model, "-C", workDir, "-o", outputFile, "--json", opts.prompt,
      ];
    }

    if (opts.images) {
      const jsonIdx = args.indexOf("--json");
      for (const img of opts.images) {
        args.splice(jsonIdx, 0, "-i", img);
      }
    }

    logger.info({ engine: "codex", model, workDir, promptLen: opts.prompt.length, resume: !!opts.resumeSessionId }, "Starting Codex execution");

    const proc = spawn(config.codex.bin, args, {
      cwd: workDir,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    runningProcesses.set(execId, { proc, startedAt: Date.now() });

    let stdout = "";
    let stderr = "";
    let threadId: string | undefined;
    let accumulatedText = "";
    let lineBuffer = "";
    let lastActivity = Date.now();
    let timedOut = false;
    let closed = false;

    proc.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      lastActivity = Date.now();
      opts.onProgress?.(text);

      lineBuffer += text;
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === "thread.started" && event.thread_id) {
            threadId = event.thread_id;
            opts.onSessionStarted?.(event.thread_id);
          }
          if (event.type === "item.completed" && event.item?.text) {
            accumulatedText += (accumulatedText ? "\n" : "") + event.item.text;
            opts.onTextEvent?.(event.item.text, accumulatedText);
          }
        } catch { /* not JSON */ }
      }
    });

    proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); lastActivity = Date.now(); });

    // Adaptive timeout
    let deadline = start + baseTimeout;
    const ACTIVITY_WINDOW = 60_000;

    const timer = setInterval(() => {
      if (closed) { clearInterval(timer); return; }
      const now = Date.now();
      if (now < deadline) return;
      if ((now - lastActivity) < ACTIVITY_WINDOW) {
        deadline = now + EXTEND_INTERVAL;
        return;
      }
      clearInterval(timer);
      timedOut = true;
      logger.warn({ elapsed: Math.round((now - start) / 1000) }, "Codex timeout");
      proc.kill("SIGTERM");
      setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
    }, 5000);

    proc.on("close", async (code) => {
      closed = true;
      clearInterval(timer);
      runningProcesses.delete(execId);
      const durationMs = Date.now() - start;

      // Process remaining buffer
      if (lineBuffer.trim()) {
        try {
          const event = JSON.parse(lineBuffer);
          if (event.type === "thread.started" && event.thread_id) threadId = event.thread_id;
          if (event.type === "item.completed" && event.item?.text) {
            accumulatedText += (accumulatedText ? "\n" : "") + event.item.text;
          }
        } catch { /* skip */ }
      }

      const afterSnap = await snapshotDir(workDir);
      const newFiles = diffSnapshots(beforeSnap, afterSnap);

      let finalOutput = "";
      if (existsSync(outputFile)) {
        try { finalOutput = readFileSync(outputFile, "utf-8"); unlinkSync(outputFile); } catch { /* ignore */ }
      }

      // Parse usage from turn.completed events
      let usage: EngineExecResult["usage"] = undefined;
      try {
        for (const line of stdout.split("\n").filter(Boolean)) {
          const event = JSON.parse(line);
          if (event.type === "turn.completed" && event.usage) {
            usage = {
              inputTokens: event.usage.input_tokens || 0,
              outputTokens: event.usage.output_tokens || 0,
              cachedTokens: event.usage.cached_input_tokens || 0,
            };
          }
          if (!threadId && event.type === "thread.started" && event.thread_id) threadId = event.thread_id;
        }
      } catch { /* non-JSON */ }

      const output = finalOutput || accumulatedText.trim() || stdout || stderr;
      recordCodexExecution(code === 0, durationMs, timedOut);

      logger.info(
        { execId, engine: "codex", exitCode: code, durationMs, outputLen: output.length, newFiles: newFiles.length, threadId, timedOut },
        "Codex execution completed",
      );

      resolve({
        success: code === 0,
        output: output.trim(),
        exitCode: code ?? 1,
        durationMs,
        timedOut,
        usage,
        newFiles,
        sessionId: threadId,
      });
    });

    proc.on("error", (err) => {
      clearInterval(timer);
      runningProcesses.delete(execId);
      resolve({
        success: false,
        output: `Codex spawn error: ${err.message}`,
        exitCode: 1, durationMs: Date.now() - start, timedOut: false, newFiles: [],
      });
    });
  });
}

// ─── Public EngineExecutor ────────────────────────────────────────────────

export const codexEngine: EngineExecutor = {
  name: "codex",

  async execute(opts: EngineExecOptions): Promise<EngineExecResult> {
    return executeCodexOnce(opts);
  },

  cancelAll(): number {
    let count = 0;
    for (const [id, entry] of runningProcesses) {
      try { entry.proc.kill("SIGTERM"); } catch { /* ignore */ }
      runningProcesses.delete(id);
      count++;
    }
    return count;
  },

  getRunningCount(): number {
    return runningProcesses.size;
  },
};
