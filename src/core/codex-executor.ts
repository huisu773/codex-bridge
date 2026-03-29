import { spawn, type ChildProcess, execFileSync, execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, readFileSync, unlinkSync, existsSync, readdirSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { logger } from "../utils/logger.js";
import { config } from "../config.js";

const execFileAsync = promisify(execFile);

export interface CodexExecOptions {
  prompt: string;
  model?: string;
  workingDir?: string;
  images?: string[];
  timeoutMs?: number;
  resumeSessionId?: string; // codex thread ID for multi-turn
  onProgress?: (chunk: string) => void;
  onTextEvent?: (text: string, accumulated: string) => void; // called on each text item
}

export interface CodexExecResult {
  success: boolean;
  output: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  usage?: { inputTokens: number; outputTokens: number; cachedTokens: number };
  newFiles: string[];
  threadId?: string; // codex session ID for resume
}

export interface RealUsageStats {
  fiveHour: { requests: number; tokens: number };
  weekly: { requests: number; tokens: number };
  fiveHourResetAt: Date;
  weeklyResetAt: Date;
}

const HOME = process.env.HOME || "/root";
const CODEX_STATE_DB = join(HOME, ".codex", "state_5.sqlite");

const AUTH_FILE = join(HOME, ".codex", "auth.json");

export async function getRealUsageStats(): Promise<RealUsageStats> {
  const now = Math.floor(Date.now() / 1000);
  const fiveHrAgo = now - 5 * 3600;
  const weekAgo = now - 7 * 24 * 3600;

  let fiveHour = { requests: 0, tokens: 0 };
  let weekly = { requests: 0, tokens: 0 };
  let earliestFiveHr = 0;
  let earliestWeekly = 0;

  try {
    if (existsSync(CODEX_STATE_DB)) {
      const { stdout: fiveHrResult } = await execFileAsync(
        "sqlite3",
        [CODEX_STATE_DB, `SELECT COUNT(*), COALESCE(SUM(tokens_used),0), MIN(created_at) FROM threads WHERE created_at >= ${fiveHrAgo};`],
        { encoding: "utf-8", timeout: 5000 },
      );
      const fiveHrParts = fiveHrResult.trim().split("|");
      fiveHour = { requests: Number(fiveHrParts[0]) || 0, tokens: Number(fiveHrParts[1]) || 0 };
      earliestFiveHr = Number(fiveHrParts[2]) || 0;

      const { stdout: weeklyResult } = await execFileAsync(
        "sqlite3",
        [CODEX_STATE_DB, `SELECT COUNT(*), COALESCE(SUM(tokens_used),0), MIN(created_at) FROM threads WHERE created_at >= ${weekAgo};`],
        { encoding: "utf-8", timeout: 5000 },
      );
      const weeklyParts = weeklyResult.trim().split("|");
      weekly = { requests: Number(weeklyParts[0]) || 0, tokens: Number(weeklyParts[1]) || 0 };
      earliestWeekly = Number(weeklyParts[2]) || 0;
    }
  } catch (err) {
    logger.warn({ err }, "Failed to read Codex state DB for usage stats");
  }

  const fiveHourResetAt = earliestFiveHr
    ? new Date((earliestFiveHr + 5 * 3600) * 1000)
    : new Date((now + 5 * 3600) * 1000);

  const weeklyResetAt = earliestWeekly
    ? new Date((earliestWeekly + 7 * 24 * 3600) * 1000)
    : new Date((now + 7 * 24 * 3600) * 1000);

  return { fiveHour, weekly, fiveHourResetAt, weeklyResetAt };
}

interface RunningProcess {
  proc: ChildProcess;
  startedAt: number;
}

const runningProcesses = new Map<string, RunningProcess>();

// Periodic cleanup of stale process handles (in case close event never fires)
setInterval(() => {
  const now = Date.now();
  const STALE_MS = 24 * 3600_000;
  for (const [id, entry] of runningProcesses) {
    if (now - entry.startedAt > STALE_MS) {
      logger.warn({ execId: id, elapsedMin: Math.round((now - entry.startedAt) / 60_000) }, "Cleaning up stale process handle");
      try { entry.proc.kill("SIGKILL"); } catch {}
      runningProcesses.delete(id);
    }
  }
}, 300_000);

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

export async function executeCodex(
  opts: CodexExecOptions,
): Promise<CodexExecResult> {
  const model = opts.model || config.codex.model;
  const workDir = opts.workingDir || config.codex.workingDir;
  const baseTimeout = opts.timeoutMs || config.codex.timeoutMs;
  const EXTEND_INTERVAL = 120_000; // Extend by 2 min each time

  const beforeSnap = await snapshotDir(workDir);
  const outputFile = join(tmpdir(), `codex-out-${randomUUID().slice(0, 8)}.txt`);

  let args: string[];

  if (opts.resumeSessionId) {
    // Multi-turn: resume existing codex session
    args = [
      "exec",
      "resume",
      opts.resumeSessionId,
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "-m", model,
      "-o", outputFile,
      "--json",
      opts.prompt,
    ];
  } else {
    args = [
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "-m", model,
      "-C", workDir,
      "-o", outputFile,
      "--json",
      opts.prompt,
    ];
  }

  if (opts.images) {
    // Insert image flags before --json
    const jsonIdx = args.indexOf("--json");
    for (const img of opts.images) {
      args.splice(jsonIdx, 0, "-i", img);
    }
  }

  logger.info(
    { model, workDir, promptLen: opts.prompt.length, resume: !!opts.resumeSessionId },
    "Executing codex",
  );

  const start = Date.now();
  const execId = randomUUID().slice(0, 8);

  return new Promise<CodexExecResult>((resolve) => {
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
    let lastActivityTime = Date.now();
    let timedOut = false;
    let processClosed = false;

    proc.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      lastActivityTime = Date.now();
      opts.onProgress?.(text);

      // Parse JSONL events for streaming
      lineBuffer += text;
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() || ""; // keep incomplete last line

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          // Extract thread ID
          if (event.type === "thread.started" && event.thread_id) {
            threadId = event.thread_id;
          }
          // Extract text from item.completed events for streaming
          if (event.type === "item.completed" && event.item?.text) {
            accumulatedText += (accumulatedText ? "\n" : "") + event.item.text;
            opts.onTextEvent?.(event.item.text, accumulatedText);
          }
        } catch {
          // Not valid JSON, skip
        }
      }
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      lastActivityTime = Date.now();
    });

    // Adaptive timeout: never time out while Codex is actively producing output
    let currentDeadline = start + baseTimeout;
    const ACTIVITY_WINDOW = 60_000; // Consider "active" if output within last 60s

    const adaptiveTimer = setInterval(() => {
      if (processClosed) { clearInterval(adaptiveTimer); return; }
      const now = Date.now();
      if (now < currentDeadline) return; // Not yet at deadline

      const recentlyActive = (now - lastActivityTime) < ACTIVITY_WINDOW;

      if (recentlyActive) {
        // Still active — keep extending, no upper limit
        currentDeadline = now + EXTEND_INTERVAL;
        const elapsed = Math.round((now - start) / 1000);
        logger.info({ elapsed }, "Codex still active, extending timeout");
        return;
      }

      // Deadline reached and no recent activity — timed out
      clearInterval(adaptiveTimer);
      timedOut = true;
      const elapsed = Math.round((now - start) / 1000);
      logger.warn({ elapsed }, "Codex execution timed out (no recent activity)");
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) proc.kill("SIGKILL");
      }, 5000);
    }, 5000); // Check every 5 seconds

    proc.on("close", async (code) => {
      processClosed = true;
      clearInterval(adaptiveTimer);
      runningProcesses.delete(execId);
      const durationMs = Date.now() - start;

      // Process remaining line buffer
      if (lineBuffer.trim()) {
        try {
          const event = JSON.parse(lineBuffer);
          if (event.type === "thread.started" && event.thread_id) {
            threadId = event.thread_id;
          }
          if (event.type === "item.completed" && event.item?.text) {
            accumulatedText += (accumulatedText ? "\n" : "") + event.item.text;
          }
        } catch {
          // skip
        }
      }

      const afterSnap = await snapshotDir(workDir);
      const newFiles = diffSnapshots(beforeSnap, afterSnap);

      let finalOutput = "";
      if (existsSync(outputFile)) {
        try {
          finalOutput = readFileSync(outputFile, "utf-8");
          unlinkSync(outputFile);
        } catch {
          // Ignore cleanup errors
        }
      }

      // Parse JSON events from stdout for usage tracking
      let usage: CodexExecResult["usage"] = undefined;
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
          if (!threadId && event.type === "thread.started" && event.thread_id) {
            threadId = event.thread_id;
          }
        }
      } catch {
        // Non-JSON output
      }

      // Prefer -o file output, then accumulated streaming text, then raw stdout
      const output = finalOutput || accumulatedText.trim() || stdout || stderr;

      logger.info(
        { exitCode: code, durationMs, outputLen: output.length, usage, newFilesCount: newFiles.length, threadId, timedOut },
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
        threadId,
      });
    });

    proc.on("error", (err) => {
      clearInterval(adaptiveTimer);
      runningProcesses.delete(execId);
      logger.error({ err }, "Codex spawn error");
      resolve({
        success: false,
        output: `Error spawning codex: ${err.message}`,
        exitCode: 1,
        durationMs: Date.now() - start,
        timedOut: false,
        newFiles: [],
      });
    });
  });
}

export function cancelRunningTask(execId: string): boolean {
  const entry = runningProcesses.get(execId);
  if (entry) {
    entry.proc.kill("SIGTERM");
    runningProcesses.delete(execId);
    return true;
  }
  return false;
}

export function cancelAllTasks(): number {
  let count = 0;
  for (const [id, entry] of runningProcesses) {
    entry.proc.kill("SIGTERM");
    runningProcesses.delete(id);
    count++;
  }
  return count;
}

export function getRunningTaskCount(): number {
  return runningProcesses.size;
}
