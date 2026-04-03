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
  activateSession,
  updateSessionModel,
  listAllSessions,
  appendConversation,
} from "../core/session-manager.js";
import {
  getEngine,
  getExecutor,
  cancelAllEngines,
  getTotalRunningCount,
  restoreEngineOverride,
} from "../engines/index.js";
import { nowISO } from "../utils/helpers.js";
import { getServiceMetrics } from "../utils/metrics.js";
import { getCodexAccountInfo, getCopilotAccountInfo, getClaudeAccountInfo } from "./utils.js";

export function registerSessionCommands(): void {
  registerCommand({
    name: "new",
    description: "Start a new session",
    usage: "/new",
    execute: async (msg, _args, sendReply) => {
      const chatKey = `${msg.platform}:${msg.chatId}`;
      const engine = getEngine(chatKey);
      // Preserve current model selection across /new
      const prevSession = getSession(msg.platform, msg.chatId);
      const prevModel = prevSession?.model;
      deactivateSession(msg.platform, msg.chatId);
      const session = createSession(msg.platform, msg.chatId, msg.userId);
      if (prevModel) {
        updateSessionModel(session, prevModel);
      }
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
      const claudeAccount = getClaudeAccountInfo();
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
              : engine === "claude"
              ? `🔗 Claude session: ${session.claudeSessionId || "none"}`
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
        metrics.claude.total > 0
          ? `Claude: ${metrics.claude.total} runs (${metrics.claude.success} ok, ${metrics.claude.failed} fail), avg ${metrics.claude.avgDurationMs}ms`
          : "Claude: no runs yet",
        `Running: ${totalRunning} task(s)`,
        "",
        "— Session —",
        sessionInfo,
        `Sessions: ${allSessions.length}`,
        "",
        "— Account —",
        `Codex Plan: ${account.plan || "unknown"}`,
        account.subscriptionStatus ? `Codex Sub: ${account.subscriptionStatus}` : "",
        copilotAccount.user ? `Copilot User: ${copilotAccount.user}` : "",
        copilotAccount.tokenStatus ? `Copilot Token: ${copilotAccount.tokenStatus}` : "",
        claudeAccount.version ? `Claude: v${claudeAccount.version} ${claudeAccount.status || ""}` : (claudeAccount.status || ""),
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
      const models = executor.listModels();

      if (!args) {
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
      const allowedModels = new Set(models.map((m) => m.id));
      if (!allowedModels.has(newModel)) {
        await sendReply(
          `❌ Unsupported model for ${executor.name}: \`${newModel}\`\n` +
            `Use \`/models\` to see the documented model list.`,
        );
        return;
      }

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
        : engine === "claude"
        ? session.claudeSessionId || undefined
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
            return `• ${s.id} | ${s.platform} | engine: ${engineLabel} | msgs: ${s.messageCount}\n  model: ${s.model}\n  📁 ${s.sessionDir}\n  🔗 codex: ${s.codexSessionId || "none"} | copilot: ${s.copilotSessionId || "none"} | claude: ${s.claudeSessionId || "none"}\n  files: ${stats.totalGeneratedFiles} generated, ${stats.totalReceivedFiles} received | tokens: ${stats.totalTokensUsed}\n  created: ${s.createdAt}`;
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
      const { codex, copilot, claude } = cancelAllEngines();
      const total = codex + copilot + claude;
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
    description: "Resume a previous session by ID, or show recent sessions",
    usage: "/resume [session_id]",
    execute: async (msg, args, sendReply) => {
      if (args) {
        // Resume a specific session by ID
        const targetId = args.trim();
        const allSessions = listAllSessions();
        const target = allSessions.find((s) => s.id === targetId);
        if (!target) {
          await sendReply(`❌ Session not found: ${targetId}\nUse \`/resume\` to list recent sessions.`);
          return;
        }
        // Deactivate current session first
        deactivateSession(msg.platform, msg.chatId);
        // Re-activate the target session for this chat
        target.chatId = msg.chatId;
        target.platform = msg.platform;
        target.updatedAt = nowISO();
        // Persist updated meta and set as active in-memory
        activateSession(target);

        const chatKey = `${msg.platform}:${msg.chatId}`;
        if (target.engine) {
          restoreEngineOverride(chatKey, target.engine);
        }
        const engine = getEngine(chatKey);
        const threadInfo = engine === "copilot"
          ? `🔗 Copilot session: ${target.copilotSessionId || "none"}`
          : engine === "claude"
          ? `🔗 Claude session: ${target.claudeSessionId || "none"}`
          : `🔗 Codex thread: ${target.codexSessionId || "none"}`;
        await sendReply(
          `♻️ Resumed session: ${target.id}\nMessages: ${target.messageCount}\nModel: ${target.model}\n${threadInfo}`,
        );
      } else {
        // Show last 5 sessions
        const allSessions = listAllSessions();
        if (allSessions.length === 0) {
          await sendReply("📭 No sessions found.\nUse /new to start one.");
          return;
        }
        // Sort by updatedAt descending
        allSessions.sort((a, b) => {
          const ta = Date.parse(a.updatedAt) || 0;
          const tb = Date.parse(b.updatedAt) || 0;
          return tb - ta;
        });
        const recent = allSessions.slice(0, 5);
        const currentSession = getSession(msg.platform, msg.chatId);
        const lines = [
          "📂 **Recent Sessions** (last 5)\n",
          ...recent.map((s) => {
            const active = currentSession && currentSession.id === s.id ? " ✅ active" : "";
            return `• \`${s.id}\`${active}\n  msgs: ${s.messageCount} | model: ${s.model}\n  updated: ${s.updatedAt}`;
          }),
          "",
          "💡 Use `/resume <session_id>` to resume a specific session.",
        ];
        await sendReply(lines.join("\n"));
      }
    },
  });
}
