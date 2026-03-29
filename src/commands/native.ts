import { registerCommand } from "./registry.js";
import {
  createSession,
  getSession,
  getOrCreateSession,
  deleteSession,
  updateSessionModel,
  updateCodexSessionId,
  listAllSessions,
  appendConversation,
  saveGeneratedFile,
  consumePendingFiles,
} from "../core/session-manager.js";
import {
  executeCodex,
  cancelAllTasks,
  getRunningTaskCount,
} from "../core/codex-executor.js";
import { config } from "../config.js";
import { nowISO } from "../utils/helpers.js";
import { readFileSync, existsSync, statSync } from "node:fs";
import type { PlatformMessage } from "../platforms/types.js";

// Per-chat task queue for parallel execution across chats
const chatQueues = new Map<string, Promise<void>>();

function enqueueChatTask(chatKey: string, task: () => Promise<void>): Promise<void> {
  const previous = chatQueues.get(chatKey) || Promise.resolve();
  const current = previous.then(task).catch((err) => {
    // Don't let errors break the queue chain
    const { logger } = require("../utils/logger.js");
    logger.error({ err, chatKey }, "Chat task queue error");
  });
  chatQueues.set(chatKey, current);
  return current;
}

function getCodexAccountInfo(): Record<string, string> {
  const info: Record<string, string> = {};
  try {
    const authPath = process.env.HOME
      ? `${process.env.HOME}/.codex/auth.json`
      : "/root/.codex/auth.json";
    if (!existsSync(authPath)) return info;

    const auth = JSON.parse(readFileSync(authPath, "utf-8"));
    info.authMode = auth.auth_mode || "unknown";

    const tokens = auth.tokens;
    if (tokens?.access_token) {
      const parts = tokens.access_token.split(".");
      if (parts.length >= 2) {
        const payload = JSON.parse(
          Buffer.from(parts[1], "base64url").toString("utf-8"),
        );
        const chatgptAuth = payload["https://api.openai.com/auth"] || {};
        info.plan = chatgptAuth.chatgpt_plan_type || "unknown";
        info.userId = chatgptAuth.chatgpt_user_id || "";

        const profile = payload["https://api.openai.com/profile"] || {};
        info.email = profile.email || "";

        if (payload.exp) {
          const expDate = new Date(payload.exp * 1000);
          const now = new Date();
          const hoursLeft = Math.round(
            (expDate.getTime() - now.getTime()) / 3600_000,
          );
          info.tokenExpiry = expDate.toISOString();
          info.tokenStatus =
            hoursLeft > 0 ? `✅ Valid (${hoursLeft}h left)` : "❌ Expired";
        }
      }
    }

    if (tokens?.id_token) {
      const parts = tokens.id_token.split(".");
      if (parts.length >= 2) {
        const payload = JSON.parse(
          Buffer.from(parts[1], "base64url").toString("utf-8"),
        );
        const chatgptAuth = payload["https://api.openai.com/auth"] || {};
        if (chatgptAuth.chatgpt_subscription_active_until) {
          const until = new Date(chatgptAuth.chatgpt_subscription_active_until);
          const now = new Date();
          const daysLeft = Math.round(
            (until.getTime() - now.getTime()) / 86400_000,
          );
          info.subscriptionUntil = until.toISOString().split("T")[0];
          info.subscriptionStatus =
            daysLeft > 0 ? `✅ Active (${daysLeft}d left)` : "❌ Expired";
        }
      }
    }

    if (auth.last_refresh) {
      info.lastRefresh = auth.last_refresh;
    }
  } catch {
    // Ignore parse errors
  }
  return info;
}

export function registerNativeCommands(): void {
  registerCommand({
    name: "new",
    description: "Start a new Codex session",
    usage: "/new",
    execute: async (msg, _args, sendReply) => {
      deleteSession(msg.platform, msg.chatId);
      const session = createSession(msg.platform, msg.chatId, msg.userId);
      await sendReply(
        `🆕 New session created: ${session.id}\n` +
          `Model: ${session.model}\n` +
          `Working dir: ${session.workingDir}`,
      );
    },
  });

  registerCommand({
    name: "status",
    aliases: ["s"],
    description: "Show current session and system status",
    usage: "/status",
    execute: async (msg, _args, sendReply) => {
      const session = getSession(msg.platform, msg.chatId);
      const running = getRunningTaskCount();
      const allSessions = listAllSessions();
      const account = getCodexAccountInfo();

      const lines = [
        "📊 **Status**",
        "",
        "— Session —",
        session
          ? `ID: ${session.id}\nModel: ${session.model}\nMessages: ${session.messageCount}\nWorkdir: ${session.workingDir}\n📁 Session: ${session.sessionDir || "N/A"}\n🔗 Codex thread: ${session.codexSessionId || "none"}`
          : "No active session (send a message or use /new to start)",
        "",
        "— Account —",
        `Plan: ${account.plan || "unknown"}`,
        account.subscriptionStatus ? `Sub: ${account.subscriptionStatus}` : "",
        "",
        `Sessions: ${allSessions.length} | Running tasks: ${running}`,
      ].filter(Boolean);

      await sendReply(lines.join("\n"));
    },
  });

  registerCommand({
    name: "model",
    aliases: ["models", "m"],
    description: "View or switch the Codex model",
    usage: "/model [model_name]",
    execute: async (msg, args, sendReply) => {
      const session = getOrCreateSession(msg.platform, msg.chatId, msg.userId);
      if (!args) {
        await sendReply(
          `🤖 Current model: ${session.model}\n\n` +
            `To switch: /model <name>\n` +
            `Example: /model o3\n` +
            `Example: /model gpt-5.3-codex`,
        );
        return;
      }
      const newModel = args.trim();
      updateSessionModel(session, newModel);
      await sendReply(`✅ Model switched to: ${newModel}`);
    },
  });

  registerCommand({
    name: "compact",
    description: "Summarize and compact the current session context",
    usage: "/compact",
    execute: async (msg, _args, sendReply) => {
      const session = getOrCreateSession(msg.platform, msg.chatId, msg.userId);
      await sendReply("🗜️ Compacting session context...");

      const result = await executeCodex({
        prompt: "Please provide a very brief summary of our conversation so far and the current state of work. Be concise.",
        model: session.model,
        workingDir: session.workingDir,
        resumeSessionId: session.codexSessionId,
      });

      if (result.success) {
        appendConversation(session, {
          timestamp: nowISO(),
          role: "system",
          content: `[Compact summary]: ${result.output}`,
        });
        await sendReply(`📝 Session compacted.\n\nSummary:\n${result.output}`);
      } else {
        await sendReply(`❌ Compact failed: ${result.output}`);
      }
    },
  });

  registerCommand({
    name: "sessions",
    aliases: ["ls"],
    description: "List all sessions",
    usage: "/sessions",
    execute: async (_msg, _args, sendReply) => {
      const sessions = listAllSessions();
      if (sessions.length === 0) {
        await sendReply("📭 No sessions found.");
        return;
      }

      const lines = [
        `📂 **Sessions** (${sessions.length})\n`,
        ...sessions.map(
          (s) => {
            const stats = s.stats || { totalGeneratedFiles: 0, totalReceivedFiles: 0, totalTokensUsed: 0 };
            return `• ${s.id} | ${s.platform} | msgs: ${s.messageCount}\n  model: ${s.model}\n  📁 ${s.sessionDir}\n  🔗 thread: ${s.codexSessionId || "none"}\n  files: ${stats.totalGeneratedFiles} generated, ${stats.totalReceivedFiles} received\n  created: ${s.createdAt}`;
          },
        ),
      ];
      await sendReply(lines.join("\n"));
    },
  });

  registerCommand({
    name: "cancel",
    description: "Cancel all running Codex tasks",
    usage: "/cancel",
    execute: async (_msg, _args, sendReply) => {
      const count = cancelAllTasks();
      await sendReply(
        count > 0
          ? `🛑 Cancelled ${count} running task(s).`
          : "ℹ️ No running tasks to cancel.",
      );
    },
  });

  registerCommand({
    name: "clear",
    description: "Clear and delete the current session",
    usage: "/clear",
    execute: async (msg, _args, sendReply) => {
      const deleted = deleteSession(msg.platform, msg.chatId);
      await sendReply(
        deleted
          ? "🧹 Session cleared."
          : "ℹ️ No active session to clear.",
      );
    },
  });

  registerCommand({
    name: "resume",
    description: "Show current session (sessions auto-resume by chat)",
    usage: "/resume",
    execute: async (msg, _args, sendReply) => {
      const session = getSession(msg.platform, msg.chatId);
      if (session) {
        await sendReply(
          `♻️ Active session: ${session.id}\nMessages: ${session.messageCount}\nModel: ${session.model}\n🔗 Codex thread: ${session.codexSessionId || "none (will be created on next message)"}`,
        );
      } else {
        await sendReply(
          "ℹ️ No active session. Send a message to start one, or use /new.",
        );
      }
    },
  });

  // __codex_passthrough__ — Core handler for non-command messages
  registerCommand({
    name: "__codex_passthrough__",
    description: "Send message to Codex",
    usage: "(internal)",
    hidden: true,
    execute: async (msg, _args, sendReply, sendFile) => {
      const chatKey = `${msg.platform}:${msg.chatId}`;

      // Enqueue task for this chat (serialize within chat, parallel across chats)
      await enqueueChatTask(chatKey, async () => {
        const session = getOrCreateSession(msg.platform, msg.chatId, msg.userId);

        // Inject context about recently received files
        const pendingFiles = consumePendingFiles(session);
        let prompt = msg.text;
        const imageFiles: string[] = [];
        const otherFiles: string[] = [];

        for (const f of pendingFiles) {
          // Skip audio files (already transcribed)
          if (/\.(ogg|opus|mp3|wav|m4a|flac)$/i.test(f)) continue;
          if (/\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i.test(f)) {
            imageFiles.push(f);
          } else {
            otherFiles.push(f);
          }
        }

        if (otherFiles.length > 0) {
          const fileList = otherFiles.map((p) => `  - ${p}`).join("\n");
          prompt = `[Context: The user recently uploaded the following file(s) to the working directory:\n${fileList}\nPlease take these files into account when responding.]\n\n${prompt}`;
        }
        if (imageFiles.length > 0 && !prompt) {
          prompt = "Please describe or analyze the image(s) I just sent.";
        }

        appendConversation(session, {
          timestamp: nowISO(),
          role: "user",
          content: msg.text,
          files: msg.files?.map((f) => f.name),
        });

        // Streaming support
        let streamMsgId = "";
        let lastStreamUpdate = 0;
        const STREAM_THROTTLE_MS = 1500; // throttle updates to avoid API rate limits

        // Start streaming if platform supports it
        if (msg.sendStreamStart) {
          try {
            streamMsgId = await msg.sendStreamStart("⏳ Processing...");
          } catch {
            // Streaming start failed, will fall back to normal reply
          }
        }

        // Heartbeat timer: send progress every 60s
        let heartbeatCount = 0;
        const heartbeatInterval = setInterval(async () => {
          heartbeatCount++;
          const mins = heartbeatCount;
          const text = `⏳ Still working... (${mins}m elapsed)`;
          if (streamMsgId && msg.updateStream) {
            try {
              await msg.updateStream(streamMsgId, text);
            } catch { /* ignore */ }
          }
        }, 60_000);

        try {
          const result = await executeCodex({
            prompt,
            model: session.model,
            workingDir: session.workingDir,
            images: imageFiles.length > 0 ? imageFiles : undefined,
            resumeSessionId: session.codexSessionId,
            onTextEvent: (newText, accumulated) => {
              // Streaming: update message with accumulated text
              if (streamMsgId && msg.updateStream) {
                const now = Date.now();
                if (now - lastStreamUpdate >= STREAM_THROTTLE_MS) {
                  lastStreamUpdate = now;
                  msg.updateStream(streamMsgId, accumulated).catch(() => {});
                }
              }
            },
          });

          clearInterval(heartbeatInterval);

          // Save codex thread ID for multi-turn
          if (result.threadId && result.threadId !== session.codexSessionId) {
            updateCodexSessionId(session, result.threadId);
          }

          // Update token usage
          if (result.usage) {
            session.stats.totalTokensUsed += (result.usage.inputTokens + result.usage.outputTokens);
          }

          appendConversation(session, {
            timestamp: nowISO(),
            role: "assistant",
            content: result.output,
            metadata: {
              exitCode: result.exitCode,
              durationMs: result.durationMs,
              newFiles: result.newFiles,
              threadId: result.threadId,
            },
          });

          // Final response: finalize the stream card (removes "Generating..." indicator)
          if (streamMsgId && result.output) {
            const finalize = msg.finalizeStream || msg.updateStream;
            if (finalize) {
              try {
                await finalize(streamMsgId, result.output);
              } catch {
                // If stream finalize fails, send as new message
                await sendReply(result.output);
              }
            } else {
              await sendReply(result.output);
            }
          } else if (streamMsgId && !result.output) {
            // No output but stream card exists — finalize to remove "Generating..."
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

          // Save generated files to session folder (no auto-send to user)
          if (result.newFiles.length > 0) {
            let savedCount = 0;
            const MAX_FILE_SIZE = 50 * 1024 * 1024;
            for (const filePath of result.newFiles) {
              try {
                if (!existsSync(filePath)) continue;
                const stat = statSync(filePath);
                if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FILE_SIZE) continue;
                saveGeneratedFile(session, filePath, msg.platform);
                savedCount++;
              } catch {
                // Ignore individual file save errors
              }
            }
            if (savedCount > 0) {
              await sendReply(`📁 ${savedCount} file(s) created/modified and saved to session.`);
            }
          }
        } catch (err) {
          clearInterval(heartbeatInterval);
          const errMsg = `❌ Execution error: ${err instanceof Error ? err.message : String(err)}`;
          // Always try to finalize stream card to remove "Generating..." indicator
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
        }
      });
    },
  });
}
