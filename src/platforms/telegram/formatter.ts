import { splitMessage } from "../../utils/helpers.js";

const TG_MAX_LEN = 4096;
/** Split markdown at a smaller limit so HTML tags don't push past TG_MAX_LEN */
const TG_MD_SPLIT_LEN = 3200;

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
 * Handles: code blocks, inline code, bold, italic, strikethrough,
 * links, headers, lists, blockquotes, and horizontal rules.
 */
export function markdownToTelegramHtml(text: string): string {
  const codeBlocks: string[] = [];
  const inlineCodes: string[] = [];

  // Step 1: Extract fenced code blocks → placeholders
  // Support both ```lang\n...\n``` and ```lang ...``` (single line)
  let result = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, lang, code) => {
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

  // Links: [text](url) — encode quotes in URL to prevent attribute breakout
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, linkText, url) => {
    const safeUrl = url.replace(/"/g, "%22");
    return `<a href="${safeUrl}">${linkText}</a>`;
  });

  // Image links → regular links
  result = result.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, url) => {
    const safeUrl = url.replace(/"/g, "%22");
    return `<a href="${safeUrl}">${alt || "image"}</a>`;
  });

  // Headers: # text → bold with newline
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "\n<b>$1</b>");

  // Blockquotes: > text → <blockquote>
  // Collect consecutive blockquote lines into one block
  result = result.replace(
    /(?:^&gt;\s?(.*)$\n?)+/gm,
    (match) => {
      const lines = match
        .split("\n")
        .map((l) => l.replace(/^&gt;\s?/, ""))
        .filter((l) => l !== undefined);
      return `<blockquote>${lines.join("\n")}</blockquote>`;
    },
  );

  // Horizontal rules → visual separator
  result = result.replace(/^[-*_]{3,}\s*$/gm, "————————————");

  // Unordered lists: - or * at line start → bullet
  result = result.replace(/^(\s*)[-*]\s+/gm, "$1• ");

  // Step 5: Restore code blocks and inline code
  result = result.replace(/\x00CB(\d+)\x00/g, (_m, idx) => codeBlocks[Number(idx)]);
  result = result.replace(/\x00IC(\d+)\x00/g, (_m, idx) => inlineCodes[Number(idx)]);

  return result.trim();
}

/**
 * Format and split Telegram reply.
 * Splits markdown FIRST, then converts each chunk to HTML.
 * This prevents splitMessage from breaking HTML tags mid-tag,
 * which Telegram would reject as invalid HTML.
 */
export function formatTelegramReply(text: string): string[] {
  const mdChunks = splitMessage(text, TG_MD_SPLIT_LEN);
  const result: string[] = [];
  for (const chunk of mdChunks) {
    const html = markdownToTelegramHtml(chunk);
    if (html.length <= TG_MAX_LEN) {
      result.push(html);
    } else {
      // Rare: HTML entity expansion exceeded limit. Fall back to escaped plain text.
      result.push(escapeHtml(chunk).slice(0, TG_MAX_LEN));
    }
  }
  return result;
}

/**
 * Format for streaming updates (same conversion, no split).
 */
export function formatTelegramStream(text: string): string {
  const html = markdownToTelegramHtml(text);
  // Truncate to TG limit for single-message update
  return html.length > TG_MAX_LEN ? html.slice(0, TG_MAX_LEN - 20) + "\n..." : html;
}
