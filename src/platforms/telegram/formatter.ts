import { splitMessage } from "../../utils/helpers.js";

const TG_MAX_LEN = 4096;

/**
 * Escape HTML entities in text that is NOT inside code blocks.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Convert Codex markdown output to Telegram HTML format.
 * Handles: code blocks, inline code, bold, italic, strikethrough, links, headers.
 */
export function markdownToTelegramHtml(text: string): string {
  const codeBlocks: string[] = [];
  const inlineCodes: string[] = [];

  // Step 1: Extract fenced code blocks → placeholders
  let result = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
    const idx = codeBlocks.length;
    const escaped = escapeHtml(code.trimEnd());
    codeBlocks.push(
      lang
        ? `<pre><code class="language-${escapeHtml(lang)}">${escaped}</code></pre>`
        : `<pre>${escaped}</pre>`,
    );
    return `\x00CB${idx}\x00`;
  });

  // Step 2: Extract inline code → placeholders
  result = result.replace(/`([^`\n]+)`/g, (_match, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00IC${idx}\x00`;
  });

  // Step 3: Escape HTML in remaining text
  result = escapeHtml(result);

  // Step 4: Convert markdown formatting
  // Bold: **text** or __text__
  result = result.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  result = result.replace(/__(.+?)__/g, "<b>$1</b>");

  // Italic: *text* or _text_ (not within words)
  result = result.replace(/(?<![\\*\w])\*([^*\n]+)\*(?!\w)/g, "<i>$1</i>");
  result = result.replace(/(?<![\\_ \w])_([^_\n]+)_(?!\w)/g, "<i>$1</i>");

  // Strikethrough: ~~text~~
  result = result.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // Links: [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Headers: # text → bold
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "\n<b>$1</b>");

  // Step 5: Restore code blocks and inline code
  result = result.replace(/\x00CB(\d+)\x00/g, (_m, idx) => codeBlocks[Number(idx)]);
  result = result.replace(/\x00IC(\d+)\x00/g, (_m, idx) => inlineCodes[Number(idx)]);

  return result.trim();
}

/**
 * Format and split Telegram reply. Converts markdown → HTML.
 */
export function formatTelegramReply(text: string): string[] {
  const html = markdownToTelegramHtml(text);
  return splitMessage(html, TG_MAX_LEN);
}

/**
 * Format for streaming updates (same conversion, no split).
 */
export function formatTelegramStream(text: string): string {
  const html = markdownToTelegramHtml(text);
  // Truncate to TG limit for single-message update
  return html.length > TG_MAX_LEN ? html.slice(0, TG_MAX_LEN - 20) + "\n..." : html;
}
