import { splitMessage } from "../../utils/helpers.js";

const TG_MAX_LEN = 4096;

/**
 * Format and split Telegram reply into chunks.
 * Sends plain text — no HTML or Markdown formatting.
 */
export function formatTelegramReply(text: string): string[] {
  return splitMessage(text, TG_MAX_LEN);
}

/**
 * Format for streaming updates (plain text, single message).
 */
export function formatTelegramStream(text: string): string {
  return text.length > TG_MAX_LEN ? text.slice(0, TG_MAX_LEN - 20) + "\n..." : text;
}
