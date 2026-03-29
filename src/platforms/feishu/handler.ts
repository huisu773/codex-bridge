import * as lark from "@larksuiteoapi/node-sdk";
import { routeMessage } from "../../core/command-router.js";
import { isAuthorizedFeishu, checkRateLimit, sanitizeInput, filterSensitiveOutput } from "../../security/auth.js";
import { logger } from "../../utils/logger.js";
import { formatFeishuReply, buildFeishuTextContent } from "./formatter.js";
import { getOrCreateSession, saveReceivedFile } from "../../core/session-manager.js";
import { nowISO } from "../../utils/helpers.js";
import { join } from "node:path";
import { writeFileSync, createReadStream, readFileSync, statSync, existsSync } from "node:fs";
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

function isDuplicate(messageId: string): boolean {
  const now = Date.now();
  // Cleanup old entries
  for (const [id, ts] of processedMessages) {
    if (now - ts > DEDUP_TTL) processedMessages.delete(id);
  }
  if (processedMessages.has(messageId)) return true;
  processedMessages.set(messageId, now);
  return false;
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

  // Auth check
  if (!isAuthorizedFeishu(senderId)) {
    logger.warn({ senderId }, "Unauthorized Feishu user");
    await replyFeishuText(messageId, "🚫 You are not authorized to use this bot.");
    return;
  }

  // Rate limit
  if (!checkRateLimit(senderId)) {
    await replyFeishuText(messageId, "⏳ Rate limit exceeded. Please wait.");
    return;
  }

  let text = "";
  const files: PlatformFile[] = [];

  if (msgType === "text") {
    try {
      const content = JSON.parse(event.message.content);
      text = content.text || "";
      // Remove @bot mentions
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
        getBuffer: async () => {
          const resp = await client!.im.messageResource.get({
            path: { message_id: messageId, file_key: fileKey },
            params: { type: "file" },
          });
          // The SDK returns a readable stream
          const chunks: Buffer[] = [];
          for await (const chunk of resp as any) {
            chunks.push(Buffer.from(chunk));
          }
          return Buffer.concat(chunks);
        },
      });
      text = "/upload"; // Treat as upload command
    } catch (err) {
      logger.error({ err }, "Failed to parse Feishu file message");
      return;
    }
  } else if (msgType === "image") {
    try {
      const content = JSON.parse(event.message.content);
      const imageKey = content.image_key;
      files.push({
        name: "image.png",
        mimeType: "image/png",
        getBuffer: async () => {
          const resp = await client!.im.messageResource.get({
            path: { message_id: messageId, file_key: imageKey },
            params: { type: "image" },
          });
          const chunks: Buffer[] = [];
          for await (const chunk of resp as any) {
            chunks.push(Buffer.from(chunk));
          }
          return Buffer.concat(chunks);
        },
      });
    } catch (err) {
      logger.error({ err }, "Failed to parse Feishu image message");
      return;
    }
  } else {
    // Unsupported message type
    await replyFeishuText(messageId, `⚠️ Unsupported message type: ${msgType}`);
    return;
  }

  const sanitized = sanitizeInput(text);
  if (!sanitized && files.length === 0) return;

  // Save files if not an upload command
  if (files.length > 0 && !sanitized.startsWith("/upload")) {
    const session = getOrCreateSession("feishu", chatId, senderId);
    for (const f of files) {
      const buf = await f.getBuffer();
      saveReceivedFile(session, f.name, buf, "feishu");
    }
    // If no text, just acknowledge
    if (!sanitized) {
      const names = files.map((f) => f.name).join(", ");
      await replyFeishuText(messageId, `📎 Received: ${names}\nFiles saved. You can now ask Codex about them.`);
      return;
    }
  }

  const msg: PlatformMessage = {
    platform: "feishu",
    userId: senderId,
    chatId,
    text: sanitized,
    files,
  };

  const sendReply = async (replyText: string) => {
    const filtered = filterSensitiveOutput(replyText);
    const parts = formatFeishuReply(filtered);
    for (const part of parts) {
      await replyFeishuText(messageId, part);
    }
  };

  const sendFile = async (filePath: string, caption?: string) => {
    try {
      const fileName = caption || filePath.split("/").pop() || "file";
      // Use im.v1.file.create to upload
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
        // Fallback: send file path as text
        await replyFeishuText(messageId, `📎 File: ${filePath}`);
      }
    } catch (err) {
      logger.error({ err, filePath }, "Failed to send file via Feishu");
      // Fallback: try to send as text if it's small
      try {
        const stat = statSync(filePath);
        if (stat.size < 50_000) {
          const content = readFileSync(filePath, "utf-8");
          await replyFeishuText(messageId, `📄 ${filePath}\n\`\`\`\n${content}\n\`\`\``);
        } else {
          await replyFeishuText(messageId, `❌ Failed to send file: ${filePath}`);
        }
      } catch {
        await replyFeishuText(messageId, `❌ Failed to send file: ${filePath}`);
      }
    }
  };

  await routeMessage(msg, sendReply, sendFile);
}

async function replyFeishuText(messageId: string, text: string): Promise<void> {
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
