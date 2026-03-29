/**
 * Copilot CLI PTY executor.
 *
 * Spawns `copilot -i` in a pseudo-terminal, detects ask_user events,
 * delegates them to the IM via callbacks, simulates keystrokes for
 * user selections, and extracts the assistant's text response.
 *
 * Each invocation is a single premium request, regardless of how many
 * ask_user rounds occur within the turn.
 */

import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { logger } from "../utils/logger.js";
import { config } from "../config.js";
import { stripAnsi } from "./ansi-utils.js";
import { parseAskUserFromRaw, isAskUserVisible } from "./ask-user-parser.js";
import { extractAssistantText } from "./text-extractor.js";
import type {
  CopilotExecOptions,
  CopilotExecResult,
  AskUserResponse,
} from "./types.js";

// node-pty is a native CommonJS module — load via createRequire in ESM
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pty: typeof import("node-pty") = require("node-pty");

// ─── Forced ask_user instruction ───────────────────────────────────

const FORCED_INSTRUCTIONS = `# 强制交互协议

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

// ─── Running process tracking ──────────────────────────────────────

interface RunningPty {
  term: ReturnType<typeof pty.spawn>;
  startedAt: number;
}

const runningPtys = new Map<string, RunningPty>();

// Periodic cleanup of stale PTY handles
setInterval(() => {
  const now = Date.now();
  const STALE_MS = 30 * 60_000; // 30 minutes
  for (const [id, entry] of runningPtys) {
    if (now - entry.startedAt > STALE_MS) {
      logger.warn({ execId: id }, "Cleaning up stale Copilot PTY");
      try {
        entry.term.kill();
      } catch {
        /* ignore */
      }
      runningPtys.delete(id);
    }
  }
}, 60_000);

// ─── Config dir setup ──────────────────────────────────────────────

function setupSessionConfigDir(): string {
  const dir = join(
    config.copilot.configDir,
    `session-${randomUUID().slice(0, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "copilot-instructions.md"), FORCED_INSTRUCTIONS);
  return dir;
}

// ─── Helpers ───────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function simulateChoice(
  term: ReturnType<typeof pty.spawn>,
  choiceIndex: number,
): Promise<void> {
  for (let i = 0; i < choiceIndex; i++) {
    term.write("\x1b[B"); // Down arrow
    await sleep(200);
  }
  await sleep(300);
  term.write("\r"); // Enter
}

// ─── Main executor ─────────────────────────────────────────────────

export async function executeCopilot(
  opts: CopilotExecOptions,
): Promise<CopilotExecResult> {
  const model = opts.model || config.copilot.model;
  const workDir = opts.workingDir || config.codex.workingDir;
  const timeoutMs = opts.timeoutMs || config.copilot.timeoutMs;
  const idleMs = config.copilot.idleTimeoutMs;
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

  const sessionConfigDir = setupSessionConfigDir();

  const args = [
    "-i",
    opts.prompt,
    "--allow-all",
    "--model",
    model,
    "--config-dir",
    sessionConfigDir,
    "--no-color",
  ];

  logger.info(
    { model, workDir, promptLen: opts.prompt.length, execId },
    "Starting Copilot PTY execution",
  );

  return new Promise<CopilotExecResult>((resolve) => {
    let rawOutput = "";
    let lastDataTime = Date.now();
    let askUserRounds = 0;
    const textSegments: string[] = [];
    let exited = false;
    let exitCode = 0;
    let resolved = false;

    const term = pty.spawn(config.copilot.bin, args, {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: workDir,
      env: { ...process.env, TERM: "xterm-256color", NO_COLOR: "1" },
    });

    runningPtys.set(execId, { term, startedAt: Date.now() });

    const finish = (result: CopilotExecResult) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(overallTimer);
      runningPtys.delete(execId);
      try {
        term.kill();
      } catch {
        /* ignore */
      }
      try {
        rmSync(sessionConfigDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      logger.info(
        {
          execId,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          askUserRounds: result.askUserRounds,
          outputLen: result.output.length,
        },
        "Copilot execution completed",
      );
      resolve(result);
    };

    // PTY event handlers
    term.onData((data: string) => {
      rawOutput += data;
      lastDataTime = Date.now();
      opts.onProgress?.(stripAnsi(data));
    });

    term.onExit((e: { exitCode: number }) => {
      exited = true;
      exitCode = e.exitCode;
    });

    // Overall timeout
    const overallTimer = setTimeout(() => {
      if (!resolved) {
        const output =
          textSegments.join("\n\n").trim() ||
          extractAssistantText(rawOutput) ||
          "(timed out)";
        finish({
          success: false,
          output,
          exitCode: 1,
          durationMs: Date.now() - startTime,
          timedOut: true,
          newFiles: [],
          askUserRounds,
        });
      }
    }, timeoutMs);

    // Wait for PTY output to stabilize
    function waitForIdle(ms: number): Promise<void> {
      return new Promise((res) => {
        const check = setInterval(() => {
          if (exited || resolved) {
            clearInterval(check);
            res();
            return;
          }
          if (Date.now() - lastDataTime > ms) {
            clearInterval(check);
            res();
          }
        }, 500);
        // Safety cap: don't wait forever in this loop
        setTimeout(() => {
          clearInterval(check);
          res();
        }, Math.min(ms * 12, 120_000));
      });
    }

    // ─── Main processing loop ────────────────────────────────────
    const processLoop = async () => {
      try {
        // Wait for initial output (longer for first response + banner)
        await waitForIdle(10_000);

        while (!exited && !resolved) {
          // Check for ask_user
          if (isAskUserVisible(rawOutput)) {
            const parsed = parseAskUserFromRaw(rawOutput);

            if (parsed && opts.onAskUser) {
              // Extract text produced before this ask_user for streaming
              const textBefore = extractAssistantText(rawOutput);
              if (textBefore && textBefore.length > 5) {
                textSegments.push(textBefore);
                opts.onTextEvent?.(
                  textBefore,
                  textSegments.join("\n\n"),
                );
              }

              logger.info(
                {
                  execId,
                  round: askUserRounds + 1,
                  question: parsed.question.slice(0, 80),
                  choiceCount: parsed.choices.length,
                },
                "ask_user detected",
              );

              // Delegate to IM — this blocks until user responds or times out
              let response: AskUserResponse;
              try {
                response = await opts.onAskUser({
                  question: parsed.question,
                  choices: parsed.choices,
                  hasFreeform: parsed.hasFreeform,
                  hintLine: parsed.hintLine,
                });
              } catch (err) {
                logger.warn(
                  { err, execId },
                  "onAskUser callback failed, auto-selecting first option",
                );
                response = { type: "choice", choiceIndex: 0 };
              }

              askUserRounds++;
              rawOutput = ""; // Clear buffer for next segment

              if (
                response.type === "timeout" ||
                response.type === "cancel"
              ) {
                // ESC out of ask_user and end
                term.write("\x1b");
                await sleep(300);
                term.write("\x1b");
                await sleep(500);
                break;
              }

              if (
                response.type === "choice" &&
                response.choiceIndex !== undefined
              ) {
                await simulateChoice(term, response.choiceIndex);
              } else {
                // Freeform or unknown → select first option
                await simulateChoice(term, 0);
              }

              // Wait for next output after selection
              await waitForIdle(idleMs);
              continue;
            }
          }

          // No ask_user visible — check if tools are running
          const clean = stripAnsi(rawOutput);
          if (
            /[●◉◐○]\s+(Running|Working|Executing)/i.test(clean) &&
            !exited
          ) {
            await sleep(2000);
            continue;
          }

          // Output has stabilized, no ask_user, no tools → turn is complete
          break;
        }

        // Extract final text
        const finalText = extractAssistantText(rawOutput);
        if (finalText && finalText.length > 5) {
          textSegments.push(finalText);
        }

        const output = textSegments.join("\n\n").trim() || "(no output)";

        finish({
          success: true,
          output,
          exitCode: exited ? exitCode : 0,
          durationMs: Date.now() - startTime,
          timedOut: false,
          newFiles: [],
          askUserRounds,
        });
      } catch (err) {
        logger.error({ err, execId }, "Copilot execution error");
        finish({
          success: false,
          output: `Error: ${err instanceof Error ? err.message : String(err)}`,
          exitCode: 1,
          durationMs: Date.now() - startTime,
          timedOut: false,
          newFiles: [],
          askUserRounds,
        });
      }
    };

    processLoop();
  });
}

// ─── Task management ───────────────────────────────────────────────

export function cancelAllCopilotTasks(): number {
  let count = 0;
  for (const [id, entry] of runningPtys) {
    try {
      entry.term.kill();
    } catch {
      /* ignore */
    }
    runningPtys.delete(id);
    count++;
  }
  return count;
}

export function getRunningCopilotCount(): number {
  return runningPtys.size;
}
