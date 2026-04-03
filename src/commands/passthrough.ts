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
  updateClaudeSessionId,
  appendConversation,
  saveGeneratedFile,
  consumePendingFiles,
  recordFileSent,
} from "../core/session-manager.js";
import { getEngine, getExecutor } from "../engines/index.js";
import { config } from "../config.js";
import { nowISO } from "../utils/helpers.js";
import { existsSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { logger } from "../utils/logger.js";
import { buildPromptWithFiles, classifyError, enqueueChatTask } from "./utils.js";
import { hasSensitiveContent } from "../security/file-safety.js";

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
        let latestAccumulatedText = "";
        let streamUpdateSeq = 0;
        let streamFinalizing = false;
        let streamUpdateChain = Promise.resolve();
        const STREAM_THROTTLE_MS = msg.platform === "feishu" ? 1000 : 500;

        const queueStreamUpdate = (text: string): void => {
          if (!streamMsgId || !msg.updateStream) return;
          const seq = ++streamUpdateSeq;
          streamUpdateChain = streamUpdateChain.then(async () => {
            if (streamFinalizing) return;
            // Drop stale updates; only render the latest pending content.
            if (seq !== streamUpdateSeq) return;
            try { await msg.updateStream!(streamMsgId, text); } catch { /* ignore */ }
          });
        };

        if (msg.sendStreamStart) {
          try {
            streamMsgId = await msg.sendStreamStart("⏳ Processing...");
          } catch { /* fall back to normal reply */ }
        }

        // Heartbeat timer
        let heartbeatCount = 0;
        const heartbeatInterval = setInterval(async () => {
          heartbeatCount++;
          const heartbeatLine = `⏳ Still working... (${heartbeatCount}m elapsed)`;
          const text = latestAccumulatedText
            ? `${latestAccumulatedText}\n\n${heartbeatLine}`
            : heartbeatLine;
          queueStreamUpdate(text);
        }, 60_000);

        try {
          const engine = getEngine(chatKey);
          const executor = getExecutor(engine);

          const resumeSessionId = engine === "copilot"
            ? session.copilotSessionId || undefined
            : engine === "claude"
            ? session.claudeSessionId || undefined
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
              latestAccumulatedText = accumulated;
              if (streamMsgId && msg.updateStream) {
                const now = Date.now();
                if (now - lastStreamUpdate >= STREAM_THROTTLE_MS) {
                  lastStreamUpdate = now;
                  queueStreamUpdate(accumulated);
                }
              }
            },
          });

          // Stop heartbeat before final render to avoid late heartbeat overwriting output.
          clearInterval(heartbeatInterval);
          streamFinalizing = true;
          await streamUpdateChain.catch(() => {});

          // Save session ID for multi-turn resume
          if (result.sessionId) {
            if (engine === "copilot" && result.sessionId !== session.copilotSessionId) {
              updateCopilotSessionId(session, result.sessionId);
            } else if (engine === "claude" && result.sessionId !== session.claudeSessionId) {
              updateClaudeSessionId(session, result.sessionId);
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
              : `❌ ${engine === "copilot" ? "Copilot" : engine === "claude" ? "Claude" : "Codex"} exited with code ${result.exitCode}.`;
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
              : `❌ ${engine === "copilot" ? "Copilot" : engine === "claude" ? "Claude" : "Codex"} exited with code ${result.exitCode}.`;
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
            let tooLargeToSendCount = 0;
            let blockedSensitiveFileCount = 0;
            let blockedSensitiveContentCount = 0;
            const MAX_FILE_SIZE = 50 * 1024 * 1024;
            const MAX_SEND_SIZE = 20 * 1024 * 1024;
            const workspaceRoot = resolve(config.codex.workingDir);
            const isSensitiveFile = (p: string): boolean => {
              const name = basename(p).toLowerCase();
              if (name === ".env" || name.startsWith(".env.")) return true;
              if (name.endsWith(".pem") || name.endsWith(".key") || name.endsWith(".p12") || name.endsWith(".pfx")) return true;
              if (name === "id_rsa" || name === "id_ed25519") return true;
              return false;
            };
            for (const filePath of result.newFiles) {
              try {
                if (!existsSync(filePath)) continue;
                const absPath = resolve(filePath);
                // Only auto-capture files generated directly under workspace root.
                // Files in subdirectories are left untouched and not copied to session.
                if (dirname(absPath) !== workspaceRoot) continue;
                if (isSensitiveFile(filePath)) {
                  blockedSensitiveFileCount++;
                  logger.warn({ filePath, sessionId: session.id }, "Blocked sensitive file from auto-save/send");
                  continue;
                }
                const stat = statSync(filePath);
                if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FILE_SIZE) continue;
                const record = saveGeneratedFile(session, filePath, msg.platform, true);
                if (!record) continue;
                savedCount++;

                if (stat.size > MAX_SEND_SIZE) {
                  tooLargeToSendCount++;
                  continue;
                }
                if (hasSensitiveContent(record.sessionPath)) {
                  blockedSensitiveContentCount++;
                  logger.warn(
                    { filePath: record.sessionPath, sessionId: session.id },
                    "Blocked file send due to sensitive content",
                  );
                  continue;
                }
                try {
                  await sendFile(record.sessionPath, record.fileName);
                  recordFileSent(session, record.sessionPath, msg.platform);
                  sentCount++;
                } catch (sendErr) {
                  logger.warn({ err: sendErr, file: record.fileName }, "Failed to send file to user");
                }
              } catch {
                // Ignore individual file save errors
              }
            }
            if (savedCount > 0) {
              const sentNote = sentCount > 0 ? ` (${sentCount} sent)` : "";
              const tooLargeNote = tooLargeToSendCount > 0
                ? `\n📂 ${tooLargeToSendCount} file(s) too large to send, saved in session.`
                : "";
              const blockedFileNote = blockedSensitiveFileCount > 0
                ? `\n🔒 ${blockedSensitiveFileCount} sensitive file(s) blocked from auto-save/send.`
                : "";
              const blockedContentNote = blockedSensitiveContentCount > 0
                ? `\n🔒 ${blockedSensitiveContentCount} file(s) contained sensitive content (API key/token/secret) and were not sent.`
                : "";
              await sendReply(`📁 ${savedCount} file(s) saved${sentNote}.${tooLargeNote}${blockedFileNote}${blockedContentNote}`);
            } else if (blockedSensitiveFileCount > 0 || blockedSensitiveContentCount > 0) {
              const notes = [
                blockedSensitiveFileCount > 0
                  ? `🔒 Blocked ${blockedSensitiveFileCount} sensitive file(s) from auto-save/send.`
                  : "",
                blockedSensitiveContentCount > 0
                  ? `🔒 Blocked ${blockedSensitiveContentCount} file(s) from sending due to sensitive content.`
                  : "",
              ].filter(Boolean).join("\n");
              await sendReply(notes);
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
