import { type Context } from "grammy";
import { routeMessage } from "../../core/command-router.js";
import { isAuthorizedTelegram, checkRateLimit, sanitizeInput, filterSensitiveOutput } from "../../security/auth.js";
import { logger } from "../../utils/logger.js";
import { formatTelegramReply } from "./formatter.js";
import { getOrCreateSession, saveReceivedFile } from "../../core/session-manager.js";
import { nowISO } from "../../utils/helpers.js";
import { join, basename } from "node:path";
import { writeFileSync, createReadStream } from "node:fs";
import type { PlatformMessage, PlatformFile } from "../../platforms/types.js";

export async function handleTelegramMessage(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  const text = ctx.message?.text || ctx.message?.caption || "";

  if (!userId || !chatId) return;

  // Auth check
  if (!isAuthorizedTelegram(userId)) {
    logger.warn({ userId }, "Unauthorized Telegram user");
    await ctx.reply("🚫 You are not authorized to use this bot.");
    return;
  }

  // Rate limit
  if (!checkRateLimit(String(userId))) {
    await ctx.reply("⏳ Rate limit exceeded. Please wait a moment.");
    return;
  }

  const sanitized = sanitizeInput(text);
  if (!sanitized && !ctx.message?.document && !ctx.message?.photo) return;

  // Handle file uploads
  const files: PlatformFile[] = [];
  if (ctx.message?.document) {
    const doc = ctx.message.document;
    files.push({
      name: doc.file_name || "unnamed_file",
      mimeType: doc.mime_type,
      size: doc.file_size,
      getBuffer: async () => {
        const file = await ctx.api.getFile(doc.file_id);
        const resp = await fetch(
          `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`,
        );
        return Buffer.from(await resp.arrayBuffer());
      },
    });
  }

  if (ctx.message?.photo) {
    const photo = ctx.message.photo[ctx.message.photo.length - 1]; // Largest
    files.push({
      name: "photo.jpg",
      mimeType: "image/jpeg",
      size: photo.file_size,
      getBuffer: async () => {
        const file = await ctx.api.getFile(photo.file_id);
        const resp = await fetch(
          `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`,
        );
        return Buffer.from(await resp.arrayBuffer());
      },
    });
  }

  // Save uploaded files to session's received/ folder and working directory
  if (files.length > 0 && !sanitized.startsWith("/upload")) {
    const session = getOrCreateSession("telegram", String(chatId), String(userId));
    for (const f of files) {
      const buf = await f.getBuffer();
      saveReceivedFile(session, f.name, buf, "telegram");
    }
    // If no text, just acknowledge the file
    if (!sanitized) {
      const names = files.map((f) => f.name).join(", ");
      await ctx.reply(`📎 Received: ${names}\nFiles saved. You can now ask Codex about them.`);
      return;
    }
  }

  const msg: PlatformMessage = {
    platform: "telegram",
    userId: String(userId),
    chatId: String(chatId),
    text: sanitized,
    files,
  };

  // Show typing indicator
  await ctx.replyWithChatAction("typing").catch(() => {});

  const sendReply = async (replyText: string) => {
    const filtered = filterSensitiveOutput(replyText);
    const parts = formatTelegramReply(filtered);
    for (const part of parts) {
      try {
        await ctx.reply(part, { parse_mode: undefined });
      } catch {
        // Retry without parse mode if it fails
        await ctx.reply(part).catch(() => {});
      }
    }
  };

  const sendFile = async (filePath: string, caption?: string) => {
    try {
      const stream = createReadStream(filePath);
      await ctx.replyWithDocument(new InputFile(stream, caption || basename(filePath)), {
        caption,
      });
    } catch (err) {
      logger.error({ err, filePath }, "Failed to send file via Telegram");
      await ctx.reply(`❌ Failed to send file: ${filePath}`);
    }
  };

  await routeMessage(msg, sendReply, sendFile);
}

// Re-export InputFile for sendFile
import { InputFile } from "grammy";
