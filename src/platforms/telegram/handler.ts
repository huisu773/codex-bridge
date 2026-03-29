import { type Context } from "grammy";
import { routeMessage } from "../../core/command-router.js";
import { isAuthorizedTelegram, checkRateLimit, sanitizeInput, filterSensitiveOutput } from "../../security/auth.js";
import { logger } from "../../utils/logger.js";
import { formatTelegramReply, formatTelegramStream, escapeHtml } from "./formatter.js";
import { getOrCreateSession, saveReceivedFile } from "../../core/session-manager.js";
import { transcribe, type STTConfig } from "../../core/stt-provider.js";
import { config } from "../../config.js";
import { join, basename } from "node:path";
import { createReadStream } from "node:fs";
import type { PlatformMessage, PlatformFile } from "../../platforms/types.js";
import { InputFile } from "grammy";

async function downloadTelegramFile(ctx: Context, fileId: string): Promise<Buffer> {
  const file = await ctx.api.getFile(fileId);
  const resp = await fetch(
    `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`,
  );
  return Buffer.from(await resp.arrayBuffer());
}

export async function handleTelegramMessage(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  const text = ctx.message?.text || ctx.message?.caption || "";

  if (!userId || !chatId) return;

  if (!isAuthorizedTelegram(userId)) {
    logger.warn({ userId }, "Unauthorized Telegram user");
    await ctx.reply("🚫 You are not authorized to use this bot.");
    return;
  }

  if (!checkRateLimit(String(userId))) {
    await ctx.reply("⏳ Rate limit exceeded. Please wait a moment.");
    return;
  }

  const sanitized = sanitizeInput(text);
  const hasVoice = !!(ctx.message?.voice || ctx.message?.audio);
  const hasPhoto = !!ctx.message?.photo;
  const hasDoc = !!ctx.message?.document;
  const hasVideoNote = !!ctx.message?.video_note;

  if (!sanitized && !hasDoc && !hasPhoto && !hasVoice && !hasVideoNote) return;

  const files: PlatformFile[] = [];

  // Handle document uploads
  if (ctx.message?.document) {
    const doc = ctx.message.document;
    files.push({
      name: doc.file_name || "unnamed_file",
      mimeType: doc.mime_type,
      size: doc.file_size,
      getBuffer: () => downloadTelegramFile(ctx, doc.file_id),
    });
  }

  // Handle photo uploads
  if (ctx.message?.photo) {
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    files.push({
      name: `photo_${Date.now()}.jpg`,
      mimeType: "image/jpeg",
      size: photo.file_size,
      getBuffer: () => downloadTelegramFile(ctx, photo.file_id),
    });
  }

  // Handle voice/audio messages — transcribe via STT
  let voiceTranscription = "";
  if (hasVoice) {
    const voice = ctx.message!.voice || ctx.message!.audio!;
    const ext = ctx.message!.voice ? "ogg" : (ctx.message!.audio?.mime_type?.split("/")[1] || "mp3");
    const fileName = `voice_${Date.now()}.${ext}`;

    if (config.stt.provider !== "none") {
      await ctx.replyWithChatAction("typing").catch(() => {});
      try {
        const session = getOrCreateSession("telegram", String(chatId), String(userId));
        const buf = await downloadTelegramFile(ctx, voice.file_id);
        const savedPath = saveReceivedFile(session, fileName, buf, "telegram");
        logger.info({ savedPath, provider: config.stt.provider }, "Starting voice transcription");
        const sttResult = await transcribe(savedPath, config.stt as STTConfig);
        if (sttResult.success && sttResult.text) {
          voiceTranscription = sttResult.text;
          await ctx.reply(`🎤 <i>Voice transcribed:</i>\n${escapeHtml(sttResult.text)}`, { parse_mode: "HTML" });
        } else {
          await ctx.reply(`🎤 Voice saved. Transcription failed: ${sttResult.error || "unknown"}`);
        }
      } catch (err) {
        logger.error({ err }, "Voice transcription error");
        await ctx.reply("🎤 Voice saved but transcription failed.");
      }
    } else {
      // No STT, just save the file
      const voiceFile: PlatformFile = {
        name: fileName,
        mimeType: voice.mime_type || "audio/ogg",
        size: voice.file_size,
        getBuffer: () => downloadTelegramFile(ctx, voice.file_id),
      };
      files.push(voiceFile);
    }
  }

  // Handle video notes
  if (ctx.message?.video_note) {
    const vn = ctx.message.video_note;
    files.push({
      name: `videonote_${Date.now()}.mp4`,
      mimeType: "video/mp4",
      size: vn.file_size,
      getBuffer: () => downloadTelegramFile(ctx, vn.file_id),
    });
  }

  // Save non-voice files to session
  const isImageOnly = hasPhoto && !sanitized && !voiceTranscription;
  if (files.length > 0 && !sanitized.startsWith("/")) {
    const session = getOrCreateSession("telegram", String(chatId), String(userId));
    for (const f of files) {
      const buf = await f.getBuffer();
      saveReceivedFile(session, f.name, buf, "telegram");
    }
    // For images: auto-analyze (don't return early)
    // For documents without text: acknowledge and return
    if (!isImageOnly && !sanitized && !voiceTranscription) {
      const names = files.map((f) => f.name).join(", ");
      await ctx.reply(`📎 Received: ${names}\nFiles saved. You can now ask Codex about them.`);
      return;
    }
  }

  // Use transcription as text if no other text was provided
  let finalText = sanitized || voiceTranscription;
  if (!finalText && isImageOnly) {
    finalText = "Please describe or analyze the image(s) I just sent.";
  }
  if (!finalText && files.length === 0) return;

  const msg: PlatformMessage = {
    platform: "telegram",
    userId: String(userId),
    chatId: String(chatId),
    text: finalText,
    files,
    // Streaming callbacks for real-time message updates
    sendStreamStart: async (initText: string): Promise<string> => {
      const sent = await ctx.reply(initText);
      return String(sent.message_id);
    },
    updateStream: async (msgId: string, updatedText: string): Promise<void> => {
      try {
        const html = formatTelegramStream(updatedText);
        await ctx.api.editMessageText(chatId, Number(msgId), html, { parse_mode: "HTML" });
      } catch (err) {
        logger.warn({ err }, "Telegram stream HTML update failed, retrying plain");
        try {
          // Strip markdown syntax for readable plain-text fallback
          const plain = updatedText.replace(/[*_~`#>|]/g, "").slice(0, 4096);
          await ctx.api.editMessageText(chatId, Number(msgId), plain);
        } catch { /* edit failures often expected during streaming */ }
      }
    },
    finalizeStream: async (msgId: string, finalText: string): Promise<void> => {
      try {
        const html = formatTelegramStream(finalText);
        await ctx.api.editMessageText(chatId, Number(msgId), html, { parse_mode: "HTML" });
      } catch (err) {
        logger.warn({ err }, "Telegram stream HTML finalize failed, retrying plain");
        try {
          const plain = finalText.replace(/[*_~`#>|]/g, "").slice(0, 4096);
          await ctx.api.editMessageText(chatId, Number(msgId), plain);
        } catch { /* ignore */ }
      }
    },
  };

  await ctx.replyWithChatAction("typing").catch(() => {});

  const sendReply = async (replyText: string) => {
    const filtered = filterSensitiveOutput(replyText);
    const parts = formatTelegramReply(filtered);
    for (const part of parts) {
      try {
        await ctx.reply(part, { parse_mode: "HTML" });
      } catch (err) {
        logger.warn({ err }, "Telegram HTML reply failed, retrying as plain text");
        try {
          // Strip HTML tags from the failed part and send as plain text
          await ctx.reply(part.replace(/<[^>]+>/g, "").slice(0, 4096));
        } catch (innerErr) {
          logger.error({ err: innerErr }, "Telegram plain text reply also failed");
        }
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
