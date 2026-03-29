import * as lark from "@larksuiteoapi/node-sdk";
import { routeMessage } from "../../core/command-router.js";
import { isAuthorizedFeishu, checkRateLimit, sanitizeInput, filterSensitiveOutput } from "../../security/auth.js";
import { logger } from "../../utils/logger.js";
import { formatFeishuReply, buildFeishuTextContent, buildFeishuCard, buildFeishuStreamCard } from "./formatter.js";
import { getOrCreateSession, saveReceivedFile } from "../../core/session-manager.js";
import { transcribe, type STTConfig } from "../../core/stt-provider.js";
import { config } from "../../config.js";
import { createReadStream, readFileSync, statSync, existsSync } from "node:fs";
import type { PlatformMessage, PlatformFile } from "../../platforms/types.js";

let client: lark.Client | null = null;

export function getFeishuClient(): lark.Client | null {
  return client;
}

export function initFeishuClient(appId: string, appSecret: string): lark.Client {
  client = new lark.Client({ appId, appSecret, appType: lark.AppType.SelfBuild });
  return client;
}

// Deduplicate messages (Feishu may retry)
const processedMessages = new Map<string, number>();
const DEDUP_TTL = 60_000;
const DEDUP_MAX_SIZE = 5_000;

function isDuplicate(messageId: string): boolean {
  const now = Date.now();
  // Prune expired entries
  for (const [id, ts] of processedMessages) {
    if (now - ts > DEDUP_TTL) processedMessages.delete(id);
  }
  // Evict oldest if approaching size limit
  if (processedMessages.size >= DEDUP_MAX_SIZE) {
    const oldest = processedMessages.keys().next().value;
    if (oldest) processedMessages.delete(oldest);
  }
  if (processedMessages.has(messageId)) return true;
  processedMessages.set(messageId, now);
  return false;
}

// Periodic cleanup independent of message flow
setInterval(() => {
  const now = Date.now();
  for (const [id, ts] of processedMessages) {
    if (now - ts > DEDUP_TTL) processedMessages.delete(id);
  }
}, 5 * 60_000);

async function downloadFeishuResource(messageId: string, fileKey: string, type: string): Promise<Buffer> {
  if (!client) throw new Error("Feishu client not initialized");

  const DOWNLOAD_TIMEOUT = 30_000;

  const downloadPromise = client.im.messageResource.get({
    path: { message_id: messageId, file_key: fileKey },
    params: { type },
  });

  const timeoutPromise = new Promise<never>((_resolve, reject) =>
    setTimeout(() => reject(new Error(`Feishu resource download timed out after ${DOWNLOAD_TIMEOUT}ms`)), DOWNLOAD_TIMEOUT),
  );

  const resp = await Promise.race([downloadPromise, timeoutPromise]);

  // SDK v1.60 returns { writeFile, getReadableStream, headers }
  if (resp && typeof (resp as any).getReadableStream === "function") {
    const stream = (resp as any).getReadableStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  // Fallback: Buffer directly
  if (Buffer.isBuffer(resp)) return resp;
  if (resp instanceof ArrayBuffer) return Buffer.from(resp);
  
  // Fallback: Axios response with data
  const data = (resp as any)?.data;
  if (Buffer.isBuffer(data)) return data;
  if (data && typeof data.getReadableStream === "function") {
    const stream = data.getReadableStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  logger.warn({ type: typeof resp, keys: Object.keys(resp || {}) }, "Unknown Feishu resource response format");
  throw new Error("Cannot read Feishu resource response");
}

export async function handleFeishuEvent(event: any): Promise<void> {
  if (!client) {
    logger.error("Feishu client not initialized");
    return;
  }

  const messageId = event?.message?.message_id;
  if (!messageId || isDuplicate(messageId)) return;

  const senderId = event?.sender?.sender_id?.open_id || event?.sender?.sender_id?.user_id || "";
  const chatId = event?.message?.chat_id || "";
  const msgType = event?.message?.message_type || "";

  if (!isAuthorizedFeishu(senderId)) {
    logger.warn({ senderId }, "Unauthorized Feishu user");
    await replyFeishu(messageId, "🚫 You are not authorized to use this bot.");
    return;
  }

  if (!checkRateLimit(senderId)) {
    await replyFeishu(messageId, "⏳ Rate limit exceeded. Please wait.");
    return;
  }

  let text = "";
  const files: PlatformFile[] = [];

  if (msgType === "text") {
    try {
      const content = JSON.parse(event.message.content);
      text = content.text || "";
      text = text.replace(/@_user_\d+/g, "").trim();
    } catch {
      return;
    }
  } else if (msgType === "file") {
    try {
      const content = JSON.parse(event.message.content);
      const fileKey = content.file_key;
      const fileName = content.file_name || "unnamed_file";
      files.push({
        name: fileName,
        getBuffer: () => downloadFeishuResource(messageId, fileKey, "file"),
      });
    } catch (err) {
      logger.error({ err }, "Failed to parse Feishu file message");
      return;
    }
  } else if (msgType === "image") {
    try {
      const content = JSON.parse(event.message.content);
      const imageKey = content.image_key;
      files.push({
        name: `image_${Date.now()}.png`,
        mimeType: "image/png",
        getBuffer: () => downloadFeishuResource(messageId, imageKey, "image"),
      });
    } catch (err) {
      logger.error({ err }, "Failed to parse Feishu image message");
      return;
    }
  } else if (msgType === "audio") {
    try {
      const content = JSON.parse(event.message.content);
      const fileKey = content.file_key;
      files.push({
        name: `voice_${Date.now()}.opus`,
        mimeType: "audio/opus",
        getBuffer: () => downloadFeishuResource(messageId, fileKey, "file"),
      });
    } catch (err) {
      logger.error({ err }, "Failed to parse Feishu audio message");
      return;
    }
  } else {
    await replyFeishu(messageId, `⚠️ Unsupported message type: ${msgType}`);
    return;
  }

  const sanitized = sanitizeInput(text);
  if (!sanitized && files.length === 0) return;

  // Transcribe audio if STT is configured
  let voiceTranscription = "";
  const isAudioMsg = msgType === "audio";
  if (isAudioMsg && config.stt.provider !== "none" && files.length > 0) {
    try {
      const session = getOrCreateSession("feishu", chatId, senderId);
      const f = files[0];
      const buf = await f.getBuffer();
      const savedPath = saveReceivedFile(session, f.name, buf, "feishu");
      logger.info({ savedPath, provider: config.stt.provider }, "Starting Feishu voice transcription");
      const sttResult = await transcribe(savedPath, config.stt as STTConfig);
      if (sttResult.success && sttResult.text) {
        voiceTranscription = sttResult.text;
        await replyFeishu(messageId, `🎤 Voice transcribed:\n${sttResult.text}`);
      } else {
        await replyFeishu(messageId, `🎤 Voice saved. Transcription failed: ${sttResult.error || "unknown"}`);
      }
    } catch (err) {
      logger.error({ err }, "Feishu voice transcription error");
      await replyFeishu(messageId, "🎤 Voice saved but transcription failed.");
    }
  }

  // Save files (not already saved by voice handling)
  const isImageOnly = msgType === "image" && !sanitized;
  if (files.length > 0 && !sanitized.startsWith("/") && !isAudioMsg) {
    const session = getOrCreateSession("feishu", chatId, senderId);
    for (const f of files) {
      try {
        const buf = await f.getBuffer();
        saveReceivedFile(session, f.name, buf, "feishu");
      } catch (err) {
        logger.error({ err, fileName: f.name }, "Failed to save Feishu file");
      }
    }
    // For images: auto-analyze (don't return early)
    // For documents without text: acknowledge and return
    if (!isImageOnly && !sanitized) {
      const names = files.map((f) => f.name).join(", ");
      await replyFeishu(messageId, `📎 Received: ${names}\nFiles saved. You can now ask Codex about them.`);
      return;
    }
  }

  // Use transcription as text if no other text
  let finalText = sanitized || voiceTranscription;
  if (!finalText && isImageOnly) {
    finalText = "Please describe or analyze the image(s) I just sent.";
  }
  if (!finalText && files.length === 0) return;

  const msg: PlatformMessage = {
    platform: "feishu",
    userId: senderId,
    chatId,
    text: finalText,
    files,
    // Streaming callbacks for Feishu card updates
    sendStreamStart: async (initText: string): Promise<string> => {
      try {
        const card = buildFeishuStreamCard(initText, false);
        const resp = await client!.im.message.reply({
          path: { message_id: messageId },
          data: {
            msg_type: "interactive",
            content: JSON.stringify(card),
          },
        });
        const replyMsgId = (resp as any)?.data?.message_id || "";
        logger.info({ replyMsgId, originalMsgId: messageId }, "Feishu stream started");
        return replyMsgId;
      } catch (err) {
        logger.error({ err }, "Failed to send Feishu stream start");
        return "";
      }
    },
    updateStream: async (msgId: string, updatedText: string): Promise<void> => {
      if (!msgId) return;
      try {
        const card = buildFeishuStreamCard(updatedText, false);
        await client!.im.message.patch({
          path: { message_id: msgId },
          data: {
            content: JSON.stringify(card),
          },
        });
      } catch (err) {
        logger.debug({ err }, "Feishu stream update failed (may be expected)");
      }
    },
    finalizeStream: async (msgId: string, finalText: string): Promise<void> => {
      if (!msgId) return;
      try {
        const card = buildFeishuStreamCard(finalText, true);
        logger.info({ msgId, isComplete: true, contentLen: finalText.length }, "Feishu stream finalizing");
        await client!.im.message.patch({
          path: { message_id: msgId },
          data: {
            content: JSON.stringify(card),
          },
        });
        logger.info({ msgId }, "Feishu stream finalized successfully");
      } catch (err) {
        logger.warn({ err, msgId }, "Feishu stream finalize failed");
      }
    },
  };

  const sendReply = async (replyText: string) => {
    const filtered = filterSensitiveOutput(replyText);
    // Use card message by default for rich formatting
    try {
      const card = buildFeishuCard(filtered) as { msg_type: string; content: string };
      await client!.im.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: card.msg_type,
          content: card.content,
        },
      });
    } catch (err) {
      // Fallback to plain text if card fails
      logger.warn({ err }, "Feishu card reply failed, falling back to text");
      const parts = formatFeishuReply(filtered);
      for (const part of parts) {
        await replyFeishuPlainText(messageId, part);
      }
    }
  };

  const sendFile = async (filePath: string, caption?: string) => {
    try {
      const fileName = caption || filePath.split("/").pop() || "file";
      const fileStream = createReadStream(filePath);
      const uploadResp = await client!.im.file.create({
        data: {
          file_type: "stream" as any,
          file_name: fileName,
          file: fileStream as any,
        },
      });
      const fileKey = (uploadResp as any)?.file_key;
      if (fileKey) {
        await client!.im.message.reply({
          path: { message_id: messageId },
          data: {
            msg_type: "file",
            content: JSON.stringify({ file_key: fileKey }),
          },
        });
      } else {
        await replyFeishuPlainText(messageId, `📎 File: ${filePath}`);
      }
    } catch (err) {
      logger.error({ err, filePath }, "Failed to send file via Feishu");
      try {
        const stat = statSync(filePath);
        if (stat.size < 50_000) {
          const content = readFileSync(filePath, "utf-8");
          await replyFeishu(messageId, `📄 ${filePath}\n\`\`\`\n${content}\n\`\`\``);
        } else {
          await replyFeishu(messageId, `❌ Failed to send file: ${filePath}`);
        }
      } catch {
        await replyFeishu(messageId, `❌ Failed to send file: ${filePath}`);
      }
    }
  };

  await routeMessage(msg, sendReply, sendFile);
}

/** Send a card message reply (default) */
async function replyFeishu(messageId: string, text: string): Promise<void> {
  if (!client) return;
  try {
    const card = buildFeishuCard(text) as { msg_type: string; content: string };
    await client.im.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: card.msg_type,
        content: card.content,
      },
    });
  } catch (err) {
    // Fallback to plain text
    logger.warn({ err }, "Feishu card reply failed, falling back to text");
    await replyFeishuPlainText(messageId, text);
  }
}

/** Send a plain text message reply (fallback) */
async function replyFeishuPlainText(messageId: string, text: string): Promise<void> {
  if (!client) return;
  try {
    const payload = buildFeishuTextContent(text) as { msg_type: string; content: string };
    await client.im.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: payload.msg_type,
        content: payload.content,
      },
    });
  } catch (err) {
    logger.error({ err, messageId }, "Failed to reply via Feishu");
  }
}
