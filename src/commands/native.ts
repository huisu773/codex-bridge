import { registerCommand } from "./registry.js";
import {
  createSession,
  getSession,
  getOrCreateSession,
  deleteSession,
  updateSessionModel,
  listAllSessions,
  appendConversation,
  saveGeneratedFile,
  recordFileSent,
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
import { basename } from "node:path";
import type { PlatformMessage } from "../platforms/types.js";

function getCodexAccountInfo(): Record<string, string> {
  const info: Record<string, string> = {};
  try {
    const authPath = process.env.HOME
      ? `${process.env.HOME}/.codex/auth.json`
      : "/root/.codex/auth.json";
    if (!existsSync(authPath)) return info;

    const auth = JSON.parse(readFileSync(authPath, "utf-8"));
    info.authMode = auth.auth_mode || "unknown";

    // Decode JWT access token to extract plan info
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

        // Token expiry
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

    // Decode id_token for subscription info
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
  // /new — Create a new session
  registerCommand({
    name: "new",
    description: "Start a new Codex session",
    usage: "/new",
    execute: async (msg, _args, sendReply) => {
      // Delete old session if exists
      deleteSession(msg.platform, msg.chatId);
      const session = createSession(msg.platform, msg.chatId, msg.userId);
      await sendReply(
        `🆕 New session created: ${session.id}\n` +
          `Model: ${session.model}\n` +
          `Working dir: ${session.workingDir}`,
      );
    },
  });

  // /status — Show current session & system status
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
          ? `ID: ${session.id}\nModel: ${session.model}\nMessages: ${session.messageCount}\nWorkdir: ${session.workingDir}\n📁 Session: ${session.sessionDir || "N/A"}`
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

  // /model — View or switch model
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

  // /compact — Compact the current conversation
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

  // /sessions — List all sessions
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
            return `• ${s.id} | ${s.platform} | msgs: ${s.messageCount}\n  model: ${s.model}\n  📁 ${s.sessionDir}\n  files: ${stats.totalGeneratedFiles} generated, ${stats.totalReceivedFiles} received\n  created: ${s.createdAt}`;
          },
        ),
      ];
      await sendReply(lines.join("\n"));
    },
  });

  // /cancel — Cancel running tasks
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

  // /clear — Clear current session
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

  // /resume — Resume latest session (just info, since we auto-resume by chatId)
  registerCommand({
    name: "resume",
    description: "Show current session (sessions auto-resume by chat)",
    usage: "/resume",
    execute: async (msg, _args, sendReply) => {
      const session = getSession(msg.platform, msg.chatId);
      if (session) {
        await sendReply(
          `♻️ Active session: ${session.id}\nMessages: ${session.messageCount}\nModel: ${session.model}`,
        );
      } else {
        await sendReply(
          "ℹ️ No active session. Send a message to start one, or use /new.",
        );
      }
    },
  });

  // __codex_passthrough__ — Hidden handler for non-command messages
  registerCommand({
    name: "__codex_passthrough__",
    description: "Send message to Codex",
    usage: "(internal)",
    hidden: true,
    execute: async (msg, _args, sendReply, sendFile) => {
      const session = getOrCreateSession(msg.platform, msg.chatId, msg.userId);

      // Inject context about recently received files
      const pendingFiles = consumePendingFiles(session);
      let prompt = msg.text;
      if (pendingFiles.length > 0) {
        const fileList = pendingFiles.map((p) => `  - ${p}`).join("\n");
        prompt = `[Context: The user recently uploaded the following file(s) to the working directory:\n${fileList}\nPlease take these files into account when responding.]\n\n${prompt}`;
      }

      appendConversation(session, {
        timestamp: nowISO(),
        role: "user",
        content: msg.text,
        files: msg.files?.map((f) => f.name),
      });

      const result = await executeCodex({
        prompt,
        model: session.model,
        workingDir: session.workingDir,
      });

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
        },
      });

      if (result.output) {
        await sendReply(result.output);
      } else {
        await sendReply(
          result.success
            ? "✅ Done (no output)."
            : `❌ Codex exited with code ${result.exitCode}.`,
        );
      }

      // Auto-save generated files to session folder and send to user
      if (result.newFiles.length > 0) {
        const MAX_AUTO_SEND = 10;
        const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
        const filesToSend = result.newFiles.slice(0, MAX_AUTO_SEND);
        for (const filePath of filesToSend) {
          try {
            if (!existsSync(filePath)) continue;
            const stat = statSync(filePath);
            if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FILE_SIZE) continue;
            // Save copy to session's generated/ folder
            saveGeneratedFile(session, filePath, msg.platform);
            // Send to user
            await sendFile(filePath, basename(filePath));
            recordFileSent(session, filePath, msg.platform);
          } catch {
            // Ignore individual file send errors
          }
        }
        if (result.newFiles.length > MAX_AUTO_SEND) {
          await sendReply(
            `📁 ${result.newFiles.length} files created/modified, sent first ${MAX_AUTO_SEND}. Use /download for others.`,
          );
        }
      }
    },
  });
}
