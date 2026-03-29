import { registerCommand } from "./registry.js";
import { getOrCreateSession, updateSessionWorkingDir } from "../core/session-manager.js";
import { nowISO } from "../utils/helpers.js";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import { config } from "../config.js";

export function registerCustomCommands(): void {
  // /exec — Execute a shell command directly
  registerCommand({
    name: "exec",
    aliases: ["run", "sh"],
    description: "Execute a shell command directly",
    usage: "/exec <command>",
    execute: async (_msg, args, sendReply) => {
      if (!args) {
        await sendReply("Usage: /exec <command>");
        return;
      }
      try {
        const output = execSync(args, {
          timeout: 60_000,
          maxBuffer: 1024 * 1024,
          encoding: "utf-8",
          cwd: config.codex.workingDir,
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
        `Rate limit: ${config.security.rateLimitPerMinute}/min`,
        `Session max age: ${config.session.maxAgeHours}h`,
        `Webhook port: ${config.webhook.port}`,
      ];
      await sendReply(lines.join("\n"));
    },
  });
}
