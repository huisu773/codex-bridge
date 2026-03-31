/**
 * Session management commands: /new, /status, /model, /compact, /sessions, /cancel, /clear, /resume.
 */

import { registerCommand } from "./registry.js";
import {
  createSession,
  getSession,
  getOrCreateSession,
  deleteSession,
  deactivateSession,
  updateSessionModel,
  listAllSessions,
  appendConversation,
} from "../core/session-manager.js";
import {
  getEngine,
  getExecutor,
  cancelAllEngines,
  getTotalRunningCount,
} from "../engines/index.js";
import { nowISO } from "../utils/helpers.js";
import { getServiceMetrics } from "../utils/metrics.js";
import { getCodexAccountInfo, getCopilotAccountInfo } from "./utils.js";

export function registerSessionCommands(): void {
  registerCommand({
    name: "new",
    description: "Start a new Codex session",
    usage: "/new",
    execute: async (msg, _args, sendReply) => {
      const chatKey = `${msg.platform}:${msg.chatId}`;
      const engine = getEngine(chatKey);
      deactivateSession(msg.platform, msg.chatId);
      const session = createSession(msg.platform, msg.chatId, msg.userId);
      await sendReply(
        `🆕 New session created: ${session.id}\n` +
          `Engine: ${engine}\n` +
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
      const totalRunning = getTotalRunningCount();
      const allSessions = listAllSessions();
      const account = getCodexAccountInfo();
      const copilotAccount = getCopilotAccountInfo();
      const metrics = getServiceMetrics(totalRunning);
      const chatKey = `${msg.platform}:${msg.chatId}`;
      const engine = getEngine(chatKey);

      const sessionInfo = session
        ? [
            `ID: ${session.id}`,
            `Engine: ${engine}${session.engine ? "" : " (default)"}`,
            `Model: ${session.model}`,
            `Messages: ${session.messageCount}`,
            `Workdir: ${session.workingDir}`,
            `📁 Session: ${session.sessionDir || "N/A"}`,
            engine === "copilot"
              ? `🔗 Copilot session: ${session.copilotSessionId || "none"}`
              : `🔗 Codex thread: ${session.codexSessionId || "none"}`,
            `📊 Tokens used: ${session.stats.totalTokensUsed}`,
          ].join("\n")
        : "No active session (send a message or use /new to start)";

      const lines = [
        "📊 **Status**",
        "",
        "— Service —",
        `Uptime: ${metrics.uptime}s | Memory: ${metrics.memory.rss}MB RSS`,
        `Platforms: telegram=${metrics.platforms.telegram}, feishu=${metrics.platforms.feishu}`,
        metrics.codex.total > 0
          ? `Codex: ${metrics.codex.total} runs (${metrics.codex.success} ok, ${metrics.codex.failed} fail), avg ${metrics.codex.avgDurationMs}ms`
          : "Codex: no runs yet",
        metrics.copilot.total > 0
          ? `Copilot: ${metrics.copilot.total} runs (${metrics.copilot.success} ok, ${metrics.copilot.failed} fail), avg ${metrics.copilot.avgDurationMs}ms, ${metrics.copilot.totalAskUserRounds} ask_user rounds`
          : "Copilot: no runs yet",
        `Running: ${totalRunning} task(s)`,
        "",
        "— Session —",
        sessionInfo,
        "",
        "— Account —",
        `Codex Plan: ${account.plan || "unknown"}`,
        account.subscriptionStatus ? `Codex Sub: ${account.subscriptionStatus}` : "",
        `Copilot CLI: ${copilotAccount.binStatus || "unknown"} (${copilotAccount.bin || "unknown"})`,
        copilotAccount.version ? `Copilot Version: ${copilotAccount.version}` : "",
        `Copilot Auth: ${copilotAccount.authSource || "unknown"}`,
        copilotAccount.user ? `Copilot User: ${copilotAccount.user}` : "",
        copilotAccount.host ? `Copilot Host: ${copilotAccount.host}` : "",
        copilotAccount.tokenStatus ? `Copilot Token: ${copilotAccount.tokenStatus}` : "",
        "",
        `Sessions: ${allSessions.length}`,
      ].filter(Boolean);

      await sendReply(lines.join("\n"));
    },
  });

  registerCommand({
    name: "model",
    aliases: ["models", "m"],
    description: "View or switch the model, list available models",
    usage: "/model [model_name]  |  /models",
    execute: async (msg, args, sendReply) => {
      const session = getOrCreateSession(msg.platform, msg.chatId, msg.userId);
      const chatKey = `${msg.platform}:${msg.chatId}`;
      const engineName = getEngine(chatKey);
      const executor = getExecutor(engineName);

      if (!args) {
        const models = executor.listModels();
        const lines = models.map((m) => {
          const marker = m.id === session.model ? " ✅" : "";
          const rec = m.recommended ? " ⭐" : "";
          const desc = m.description ? ` — ${m.description}` : "";
          return `  • \`${m.id}\`${desc}${rec}${marker}`;
        });
        await sendReply(
          `🤖 Current model: \`${session.model}\`\n` +
            `🔧 Engine: ${executor.name}\n\n` +
            `📋 Available models:\n${lines.join("\n")}\n\n` +
            `To switch: \`/model <name>\`\n` +
            `Example: \`/model ${models.find((m) => m.recommended)?.id || models[0]?.id}\``,
        );
        return;
      }
      const newModel = args.trim();
      updateSessionModel(session, newModel);
      await sendReply(`✅ Model switched to: \`${newModel}\``);
    },
  });

  registerCommand({
    name: "compact",
    description: "Summarize and compact the current session context",
    usage: "/compact",
    execute: async (msg, _args, sendReply) => {
      const session = getOrCreateSession(msg.platform, msg.chatId, msg.userId);
      const chatKey = `${msg.platform}:${msg.chatId}`;
      const engine = getEngine(chatKey);
      await sendReply("🗜️ Compacting session context...");

      const compactPrompt = "Please provide a very brief summary of our conversation so far and the current state of work. Be concise.";

      const executor = getExecutor(engine);
      const resumeSessionId = engine === "copilot"
        ? session.copilotSessionId || undefined
        : session.codexSessionId || undefined;

      const result = await executor.execute({
        prompt: compactPrompt,
        model: session.model,
        workingDir: session.workingDir,
        resumeSessionId,
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
            const engineLabel = s.engine || "default";
            return `• ${s.id} | ${s.platform} | engine: ${engineLabel} | msgs: ${s.messageCount}\n  model: ${s.model}\n  📁 ${s.sessionDir}\n  🔗 codex: ${s.codexSessionId || "none"} | copilot: ${s.copilotSessionId || "none"}\n  files: ${stats.totalGeneratedFiles} generated, ${stats.totalReceivedFiles} received | tokens: ${stats.totalTokensUsed}\n  created: ${s.createdAt}`;
          },
        ),
      ];
      await sendReply(lines.join("\n"));
    },
  });

  registerCommand({
    name: "cancel",
    description: "Cancel all running tasks",
    usage: "/cancel",
    execute: async (_msg, _args, sendReply) => {
      const { codex, copilot } = cancelAllEngines();
      const total = codex + copilot;
      await sendReply(
        total > 0
          ? `🛑 Cancelled ${total} running task(s).`
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
        const chatKey = `${msg.platform}:${msg.chatId}`;
        const engine = getEngine(chatKey);
        const threadInfo = engine === "copilot"
          ? `🔗 Engine: copilot\n🔗 Copilot session: ${session.copilotSessionId || "none (new session on next message)"}`
          : `🔗 Engine: codex\n🔗 Codex thread: ${session.codexSessionId || "none (will be created on next message)"}`;
        await sendReply(
          `♻️ Active session: ${session.id}\nMessages: ${session.messageCount}\nModel: ${session.model}\n${threadInfo}`,
        );
      } else {
        await sendReply(
          "ℹ️ No active session. Send a message to start one, or use /new.",
        );
      }
    },
  });
}
