import { splitMessage } from "../../utils/helpers.js";

const TG_MAX_LEN = 4096;

export function formatTelegramReply(text: string): string[] {
  // Wrap in a code block if it looks like code/terminal output
  // Otherwise send as-is (Telegram supports markdown)
  return splitMessage(text, TG_MAX_LEN);
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
