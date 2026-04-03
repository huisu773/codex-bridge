import { registerCommand } from "./registry.js";
import { getOrCreateSession, updateSessionWorkingDir, updateSessionEngine, updateSessionModel } from "../core/session-manager.js";
import { nowISO } from "../utils/helpers.js";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import { config } from "../config.js";
import { getEngine, setEngine, getEngineLabel, type EngineName } from "../engines/index.js";

/** Allowlist of safe commands for /exec */
const EXEC_ALLOWED_PREFIXES = [
  "ls", "cat", "head", "tail", "wc", "grep", "find", "tree",
  "git status", "git log", "git diff", "git branch", "git show",
  "pwd", "df", "du", "file", "stat", "echo", "date", "whoami",
  "npm list", "npm outdated", "node -v", "npm -v", "reboot",
];

function isExecAllowed(cmd: string): boolean {
  const trimmed = cmd.trim();
  return EXEC_ALLOWED_PREFIXES.some((prefix) =>
    trimmed === prefix || trimmed.startsWith(prefix + " "),
  );
}

function defaultModelForEngine(engine: "codex" | "copilot" | "claude"): string {
  if (engine === "copilot") return config.copilot.model;
  if (engine === "claude") return config.claude.model;
  return config.codex.model;
}

export function registerCustomCommands(): void {
  // /reload — Restart codex-bridge service
  registerCommand({
    name: "reload",
    aliases: ["restart"],
    description: "Restart the codex-bridge service",
    usage: "/reload",
    execute: async (_msg, _args, sendReply) => {
      await sendReply("🔄 Restarting codex-bridge service...");
      // Small delay to let the reply send before the process dies
      setTimeout(() => {
        try {
          execSync("systemctl restart codex-bridge", { timeout: 5_000 });
        } catch {
          // If systemctl fails, fall back to self-exit (systemd will restart)
          process.exit(0);
        }
      }, 1000);
    },
  });

  // /exec — Execute a safe, read-only shell command
  registerCommand({
    name: "exec",
    aliases: ["run", "sh"],
    description: "Execute a read-only shell command (safe commands only)",
    usage: "/exec <command>  (allowed: ls, cat, git status, grep, ...)",
    execute: async (_msg, args, sendReply) => {
      if (!args) {
        await sendReply(
          "Usage: /exec <command>\n\n" +
          "Allowed commands: " + EXEC_ALLOWED_PREFIXES.join(", "),
        );
        return;
      }

      if (!isExecAllowed(args)) {
        await sendReply(
          "🚫 Command not allowed. Only safe read-only commands are permitted.\n\n" +
          "Allowed: " + EXEC_ALLOWED_PREFIXES.join(", "),
        );
        return;
      }

      try {
        const output = execSync(args, {
          timeout: 60_000,
          maxBuffer: 1024 * 1024,
          encoding: "utf-8",
          cwd: config.codex.workingDir,
          // Prevent shell expansion of dangerous operators
          shell: "/bin/bash",
        });
        await sendReply(output || "(no output)");
      } catch (err: any) {
        const msg = err.stderr || err.stdout || err.message;
        await sendReply(`❌ Error:\n${msg}`);
      }
    },
  });

  // /cd — Change Codex working directory
  registerCommand({
    name: "cd",
    description: "Change the Codex working directory",
    usage: "/cd <directory>",
    execute: async (msg, args, sendReply) => {
      if (!args) {
        const session = getOrCreateSession(msg.platform, msg.chatId, msg.userId);
        await sendReply(`📂 Current working directory: ${session.workingDir}`);
        return;
      }
      const session = getOrCreateSession(msg.platform, msg.chatId, msg.userId);
      const newDir = resolve(session.workingDir, args.trim());
      // Prevent path traversal outside the configured workspace root
      const workspaceRoot = resolve(config.codex.workingDir);
      if (!newDir.startsWith(workspaceRoot)) {
        await sendReply(`🚫 Cannot navigate outside workspace root: ${workspaceRoot}`);
        return;
      }
      if (!existsSync(newDir)) {
        await sendReply(`❌ Directory not found: ${newDir}`);
        return;
      }
      if (!statSync(newDir).isDirectory()) {
        await sendReply(`❌ Not a directory: ${newDir}`);
        return;
      }
      session.isCustomWorkingDir = true;
      updateSessionWorkingDir(session, newDir);
      await sendReply(`📂 Working directory changed to: ${newDir}`);
    },
  });

  // /config — View runtime config
  registerCommand({
    name: "config",
    aliases: ["cfg"],
    description: "View current runtime configuration",
    usage: "/config",
    execute: async (msg, _args, sendReply) => {
      const session = getOrCreateSession(msg.platform, msg.chatId, msg.userId);
      const lines = [
        "⚙️ **Runtime Configuration**",
        "",
        `Model: ${session.model}`,
        `Working dir: ${session.workingDir}`,
        `Session dir: ${config.session.dir}`,
        `Codex binary: ${config.codex.bin}`,
        `Copilot binary: ${config.copilot.bin}`,
        `Claude binary: ${config.claude.bin}`,
        `Claude base URL: ${process.env.ANTHROPIC_BASE_URL || "(system default)"}`,
        `Rate limit: ${config.security.rateLimitPerMinute}/min`,
        `Session max age: ${config.session.maxAgeHours}h`,
        `Webhook port: ${config.webhook.port}`,
      ];
      await sendReply(lines.join("\n"));
    },
  });

  // /engine — Switch between codex and copilot backends
  registerCommand({
    name: "engine",
    aliases: ["backend"],
    description: "Switch between Codex, Copilot, and Claude CLI backends",
    usage: "/engine [codex|copilot|claude]",
    execute: async (msg, args, sendReply) => {
      const chatKey = `${msg.platform}:${msg.chatId}`;

      if (!args) {
        const label = getEngineLabel(chatKey);
        const lines = [
          `🔧 Current engine: **${label}**`,
          "",
          "Available engines:",
          "  • `codex` — OpenAI Codex CLI (multi-turn via thread ID)",
          "  • `copilot` — GitHub Copilot CLI (PTY + ask_user, single request)",
          "  • `claude` — Claude Code CLI (OpenRouter, multi-turn resume)",
          "",
          "Switch: `/engine copilot` or `/engine codex` or `/engine claude`",
        ];
        await sendReply(lines.join("\n"));
        return;
      }

      const engine = args.trim().toLowerCase();
      if (engine !== "codex" && engine !== "copilot" && engine !== "claude") {
        await sendReply("❌ Invalid engine. Use `codex`, `copilot`, or `claude`.");
        return;
      }

      setEngine(chatKey, engine as EngineName);
      const session = getOrCreateSession(msg.platform, msg.chatId, msg.userId);
      updateSessionEngine(session, engine as "codex" | "copilot" | "claude");
      updateSessionModel(session, defaultModelForEngine(engine as "codex" | "copilot" | "claude"));
      const modelInfo = `Model: ${session.model}`;
      await sendReply(`✅ Engine switched to **${engine}**\n${modelInfo}`);
    },
  });
}
