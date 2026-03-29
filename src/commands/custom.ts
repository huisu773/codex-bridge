import { registerCommand } from "./registry.js";
import { getOrCreateSession, updateSessionWorkingDir, appendConversation, saveReceivedFile, recordFileSent } from "../core/session-manager.js";
import { executeCodex } from "../core/codex-executor.js";
import { nowISO } from "../utils/helpers.js";
import { readFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { join, basename, resolve } from "node:path";
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

  // /file — Read and send a file's content
  registerCommand({
    name: "file",
    aliases: ["cat"],
    description: "Read and display a file's content",
    usage: "/file <path>",
    execute: async (msg, args, sendReply) => {
      if (!args) {
        await sendReply("Usage: /file <path>");
        return;
      }
      const session = getOrCreateSession(msg.platform, msg.chatId, msg.userId);
      const filePath = resolve(session.workingDir, args.trim());
      if (!existsSync(filePath)) {
        await sendReply(`❌ File not found: ${filePath}`);
        return;
      }
      const stat = statSync(filePath);
      if (stat.size > 100_000) {
        await sendReply(
          `⚠️ File too large for inline display (${(stat.size / 1024).toFixed(1)} KB). Use /download ${args} to get the file.`,
        );
        return;
      }
      try {
        const content = readFileSync(filePath, "utf-8");
        await sendReply(`📄 ${filePath}\n\`\`\`\n${content}\n\`\`\``);
      } catch {
        await sendReply(`❌ Failed to read file: ${filePath}`);
      }
    },
  });

  // /download — Send a file via the chat platform
  registerCommand({
    name: "download",
    aliases: ["dl"],
    description: "Download a file via the chat platform",
    usage: "/download <path>",
    execute: async (msg, args, sendReply, sendFile) => {
      if (!args) {
        await sendReply("Usage: /download <path>");
        return;
      }
      const session = getOrCreateSession(msg.platform, msg.chatId, msg.userId);
      const filePath = resolve(session.workingDir, args.trim());
      if (!existsSync(filePath)) {
        await sendReply(`❌ File not found: ${filePath}`);
        return;
      }
      await sendFile(filePath, basename(filePath));
      recordFileSent(session, filePath, msg.platform);
    },
  });

  // /upload — Notify about file upload handling
  registerCommand({
    name: "upload",
    description: "Upload a file (send as attachment with this command)",
    usage: "/upload (attach file to message)",
    execute: async (msg, _args, sendReply) => {
      if (!msg.files || msg.files.length === 0) {
        await sendReply(
          "📎 To upload a file, send it as an attachment with /upload in the caption.",
        );
        return;
      }
      const session = getOrCreateSession(msg.platform, msg.chatId, msg.userId);
      const uploaded: string[] = [];

      for (const file of msg.files) {
        const buf = await file.getBuffer();
        saveReceivedFile(session, file.name, buf, msg.platform);
        uploaded.push(file.name);
      }

      await sendReply(`✅ Uploaded ${uploaded.length} file(s):\n${uploaded.map((n) => `  • ${n}`).join("\n")}\n\nFiles saved to session and working directory.`);
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
