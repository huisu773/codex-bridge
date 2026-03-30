/**
 * Passthrough handler — routes non-command messages to the active engine.
 *
 * Handles streaming, heartbeat, session persistence, file saving, and error recovery.
 */

import { registerCommand } from "./registry.js";
import {
  getOrCreateSession,
  updateCodexSessionId,
  updateCopilotSessionId,
  appendConversation,
  saveGeneratedFile,
  consumePendingFiles,
  recordFileSent,
} from "../core/session-manager.js";
import { getEngine, getExecutor } from "../engines/index.js";
import { nowISO } from "../utils/helpers.js";
import { existsSync, statSync } from "node:fs";
import { logger } from "../utils/logger.js";
import { buildPromptWithFiles, classifyError, enqueueChatTask } from "./utils.js";

export function registerPassthroughCommand(): void {
  registerCommand({
    name: "__codex_passthrough__",
    description: "Send message to backend engine",
    usage: "(internal)",
    hidden: true,
    execute: async (msg, _args, sendReply, sendFile) => {
      const chatKey = `${msg.platform}:${msg.chatId}`;

      await enqueueChatTask(chatKey, async () => {
        const session = getOrCreateSession(msg.platform, msg.chatId, msg.userId);
        const { prompt, imageFiles } = buildPromptWithFiles(msg.text, consumePendingFiles(session));

        appendConversation(session, {
          timestamp: nowISO(),
          role: "user",
          content: msg.text,
          files: msg.files?.map((f) => f.name),
        });

        // Streaming support
        let streamMsgId = "";
        let lastStreamUpdate = 0;
        const STREAM_THROTTLE_MS = msg.platform === "feishu" ? 1000 : 500;

        if (msg.sendStreamStart) {
          try {
            streamMsgId = await msg.sendStreamStart("⏳ Processing...");
          } catch { /* fall back to normal reply */ }
        }

        // Heartbeat timer
        let heartbeatCount = 0;
        const heartbeatInterval = setInterval(async () => {
          heartbeatCount++;
          const text = `⏳ Still working... (${heartbeatCount}m elapsed)`;
          if (streamMsgId && msg.updateStream) {
            try { await msg.updateStream(streamMsgId, text); } catch { /* ignore */ }
          }
        }, 60_000);

        try {
          const engine = getEngine(chatKey);
          const executor = getExecutor(engine);

          const resumeSessionId = engine === "copilot"
            ? session.copilotSessionId || undefined
            : session.codexSessionId || undefined;

          const result = await executor.execute({
            prompt,
            model: session.model,
            workingDir: session.workingDir,
            images: imageFiles.length > 0 ? imageFiles : undefined,
            resumeSessionId,
            onSessionStarted: (sid) => {
              if (engine === "codex" && sid !== session.codexSessionId) {
                updateCodexSessionId(session, sid);
              }
            },
            onTextEvent: (_newText, accumulated) => {
              if (streamMsgId && msg.updateStream) {
                const now = Date.now();
                if (now - lastStreamUpdate >= STREAM_THROTTLE_MS) {
                  lastStreamUpdate = now;
                  msg.updateStream(streamMsgId, accumulated).catch(() => {});
                }
              }
            },
          });

          // Save session ID for multi-turn resume
          if (result.sessionId) {
            if (engine === "copilot" && result.sessionId !== session.copilotSessionId) {
              updateCopilotSessionId(session, result.sessionId);
            } else if (engine === "codex" && result.sessionId !== session.codexSessionId) {
              updateCodexSessionId(session, result.sessionId);
            }
          }

          if (result.usage) {
            session.stats.totalTokensUsed += (result.usage.inputTokens + result.usage.outputTokens);
          }

          appendConversation(session, {
            timestamp: nowISO(),
            role: "assistant",
            content: result.output,
            metadata: {
              engine,
              exitCode: result.exitCode,
              durationMs: result.durationMs,
              newFiles: result.newFiles,
              sessionId: result.sessionId,
            },
          });

          // Finalize stream or send reply
          if (streamMsgId && result.output) {
            const finalize = msg.finalizeStream || msg.updateStream;
            if (finalize) {
              try {
                await finalize(streamMsgId, result.output);
              } catch {
                await sendReply(result.output);
              }
            } else {
              await sendReply(result.output);
            }
          } else if (streamMsgId && !result.output) {
            const statusMsg = result.success
              ? "✅ Done (no output)."
              : `❌ Codex exited with code ${result.exitCode}.`;
            const finalize = msg.finalizeStream || msg.updateStream;
            if (finalize) {
              await finalize(streamMsgId, statusMsg).catch(() => {});
            } else {
              await sendReply(statusMsg);
            }
          } else if (result.output) {
            await sendReply(result.output);
          } else {
            const statusMsg = result.success
              ? "✅ Done (no output)."
              : `❌ Codex exited with code ${result.exitCode}.`;
            await sendReply(statusMsg);
          }

          // Timeout recovery
          if (result.timedOut) {
            const durationMin = Math.round(result.durationMs / 60_000);
            const resumeHint = result.sessionId
              ? "\n💡 You can send a follow-up message to continue where it left off."
              : "";
            await sendReply(
              `⏰ Task timed out after ${durationMin} minute(s).${resumeHint}`,
            );
          }

          // Save generated files to session and send to user
          if (result.newFiles.length > 0) {
            let savedCount = 0;
            let sentCount = 0;
            const MAX_FILE_SIZE = 50 * 1024 * 1024;
            const MAX_SEND_SIZE = 20 * 1024 * 1024;
            const shouldMove = !session.isCustomWorkingDir;
            for (const filePath of result.newFiles) {
              try {
                if (!existsSync(filePath)) continue;
                const stat = statSync(filePath);
                if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FILE_SIZE) continue;
                const record = saveGeneratedFile(session, filePath, msg.platform, shouldMove);
                if (!record) continue;
                savedCount++;

                if (stat.size <= MAX_SEND_SIZE) {
                  try {
                    await sendFile(record.sessionPath, record.fileName);
                    recordFileSent(session, record.sessionPath, msg.platform);
                    sentCount++;
                  } catch (sendErr) {
                    logger.warn({ err: sendErr, file: record.fileName }, "Failed to send file to user");
                  }
                }
              } catch {
                // Ignore individual file save errors
              }
            }
            if (savedCount > 0) {
              const sentNote = sentCount > 0 ? ` (${sentCount} sent)` : "";
              const unsent = savedCount - sentCount;
              const unsentNote = unsent > 0 ? `\n📂 ${unsent} file(s) too large to send, saved in session.` : "";
              await sendReply(`📁 ${savedCount} file(s) saved${sentNote}.${unsentNote}`);
            }
          }
        } catch (err) {
          const errMsg = classifyError(err);
          if (streamMsgId) {
            const errFinalize = msg.finalizeStream || msg.updateStream;
            if (errFinalize) {
              await errFinalize(streamMsgId, errMsg).catch(() => {});
            } else {
              await sendReply(errMsg);
            }
          } else {
            await sendReply(errMsg);
          }
        } finally {
          clearInterval(heartbeatInterval);
        }
      });
    },
  });
}
