import { splitMessage } from "../../utils/helpers.js";

const FEISHU_MAX_LEN = 30000;

/**
 * Parse a markdown table into header + rows arrays.
 * Returns null if the text is not a valid markdown table.
 */
function parseMarkdownTable(tableText: string): { headers: string[]; rows: string[][] } | null {
  const lines = tableText.trim().split("\n").map((l) => l.trim());
  if (lines.length < 2) return null;

  const parseRow = (line: string): string[] => {
    // Remove leading/trailing pipes then split
    let trimmed = line;
    if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
    if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
    return trimmed.split("|").map((cell) => cell.trim());
  };

  const headers = parseRow(lines[0]);
  // Validate separator line (e.g., |---|---|)
  const sep = lines[1];
  if (!/^[|\s:-]+$/.test(sep)) return null;

  const rows: string[][] = [];
  for (let i = 2; i < lines.length; i++) {
    if (!lines[i]) continue;
    rows.push(parseRow(lines[i]));
  }

  return { headers, rows };
}

/**
 * Build a Feishu card table element from parsed table data.
 * Uses the "table" tag supported by Feishu card v2.
 */
function buildCardTableElement(headers: string[], rows: string[][]): any {
  const columns = headers.map((h, i) => ({
    name: `col_${i}`,
    display_name: h,
    data_type: "text",
    width: "auto",
  }));

  const tableRows = rows.map((row) => {
    const obj: Record<string, string> = {};
    headers.forEach((_h, i) => {
      obj[`col_${i}`] = row[i] ?? "";
    });
    return obj;
  });

  return {
    tag: "table",
    page_size: rows.length,
    columns,
    rows: tableRows,
  };
}

/**
 * Convert standard markdown to Feishu lark_md format.
 * lark_md supports: **bold**, *italic*, ~~strike~~, [link](url),
 * `inline code`, and ``` code blocks.
 * It does NOT support: # headers, images, bullet/numbered lists,
 * blockquotes, horizontal rules, or tables.
 * We convert unsupported syntax to visual equivalents.
 */
export function markdownToLarkMd(text: string): string {
  // Protect code blocks from transformation
  const codeBlocks: string[] = [];
  let result = text.replace(/```[\s\S]*?```/g, (match) => {
    const idx = codeBlocks.length;
    codeBlocks.push(match);
    return `\x00FSCB${idx}\x00`;
  });

  // Protect inline code
  const inlineCodes: string[] = [];
  result = result.replace(/`([^`\n]+)`/g, (match) => {
    const idx = inlineCodes.length;
    inlineCodes.push(match);
    return `\x00FSIC${idx}\x00`;
  });

  // Headers → bold (lark_md has no header support)
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "**$1**");

  // Image links → regular links
  result = result.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "[$1]($2)");

  // Blockquotes → indented with "┃ " prefix
  result = result.replace(/^>\s?(.*)$/gm, "┃ $1");

  // Horizontal rules → visual separator
  result = result.replace(/^[-*_]{3,}\s*$/gm, "────────────────────");

  // Unordered lists: normalize - and * bullets to •
  result = result.replace(/^(\s*)[-*]\s+/gm, "$1• ");

  // Ordered lists: keep numbers, add proper formatting
  result = result.replace(/^(\s*)(\d+)\.\s+/gm, "$1$2. ");

  // Restore inline code and code blocks
  result = result.replace(/\x00FSIC(\d+)\x00/g, (_m, idx) => inlineCodes[Number(idx)]);
  result = result.replace(/\x00FSCB(\d+)\x00/g, (_m, idx) => codeBlocks[Number(idx)]);

  return result;
}

/**
 * Extract markdown tables from text and return card elements.
 * Tables are replaced with placeholders; the caller assembles elements.
 */
export function splitTextAndTables(text: string): Array<{ type: "text"; content: string } | { type: "table"; headers: string[]; rows: string[][] }> {
  const parts: Array<{ type: "text"; content: string } | { type: "table"; headers: string[]; rows: string[][] }> = [];

  // Regex to match markdown tables (header + separator + data rows)
  const tableRegex = /(?:^|\n)((?:\|[^\n]+\|\s*\n)\|[-:\s|]+\|\s*\n(?:\|[^\n]+\|\s*\n?)+)/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tableRegex.exec(text)) !== null) {
    const tableStart = match.index + (text[match.index] === "\n" ? 1 : 0);
    // Push preceding text
    if (tableStart > lastIndex) {
      const before = text.slice(lastIndex, tableStart).trim();
      if (before) parts.push({ type: "text", content: before });
    }

    const parsed = parseMarkdownTable(match[1]);
    if (parsed) {
      parts.push({ type: "table", headers: parsed.headers, rows: parsed.rows });
    } else {
      // Fallback: treat as text
      parts.push({ type: "text", content: match[1].trim() });
    }
    lastIndex = match.index + match[0].length;
  }

  // Remaining text after last table
  if (lastIndex < text.length) {
    const remaining = text.slice(lastIndex).trim();
    if (remaining) parts.push({ type: "text", content: remaining });
  }

  // No tables found — return single text part
  if (parts.length === 0 && text.trim()) {
    parts.push({ type: "text", content: text });
  }

  return parts;
}

export function formatFeishuReply(text: string): string[] {
  return splitMessage(text, FEISHU_MAX_LEN);
}

/** Plain text message content */
export function buildFeishuTextContent(text: string): object {
  return {
    msg_type: "text",
    content: JSON.stringify({ text }),
  };
}

/**
 * Build a Feishu interactive card message.
 * Cards support lark_md (markdown-like) formatting natively.
 * Markdown tables are converted to native Feishu card table elements.
 */
export function buildFeishuCard(text: string, title?: string, color?: string): object {
  const elements: any[] = [];

  const parts = splitTextAndTables(text);
  const hasTables = parts.some((p) => p.type === "table");

  if (hasTables) {
    for (const part of parts) {
      if (part.type === "table") {
        elements.push(buildCardTableElement(part.headers, part.rows));
      } else {
        let larkText = markdownToLarkMd(part.content);
        if (larkText.length > FEISHU_MAX_LEN) {
          larkText = larkText.slice(0, FEISHU_MAX_LEN - 10) + "\n...";
        }
        elements.push({
          tag: "div",
          text: {
            tag: "lark_md",
            content: larkText,
          },
        });
      }
    }
  } else {
    // No tables — original behavior
    let larkText = markdownToLarkMd(text);
    if (larkText.length > FEISHU_MAX_LEN) {
      larkText = larkText.slice(0, FEISHU_MAX_LEN - 10) + "\n...";
    }
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: larkText,
      },
    });
  }

  const card: any = {
    config: {
      wide_screen_mode: true,
    },
    elements,
  };

  if (title) {
    card.header = {
      title: {
        tag: "plain_text",
        content: title,
      },
      template: color || "blue",
    };
  }

  return {
    msg_type: "interactive",
    content: JSON.stringify(card),
  };
}

/**
 * Build a streaming progress card (with a "typing" indicator).
 */
export function buildFeishuStreamCard(text: string, isComplete = false): object {
  const elements: any[] = [];

  if (text) {
    // For streaming cards, also handle tables in the final render
    if (isComplete) {
      const parts = splitTextAndTables(text);
      const hasTables = parts.some((p) => p.type === "table");
      if (hasTables) {
        for (const part of parts) {
          if (part.type === "table") {
            elements.push(buildCardTableElement(part.headers, part.rows));
          } else {
            elements.push({
              tag: "div",
              text: {
                tag: "lark_md",
                content: markdownToLarkMd(part.content),
              },
            });
          }
        }
      } else {
        elements.push({
          tag: "div",
          text: {
            tag: "lark_md",
            content: markdownToLarkMd(text),
          },
        });
      }
    } else {
      elements.push({
        tag: "div",
        text: {
          tag: "lark_md",
          content: markdownToLarkMd(text),
        },
      });
    }
  }

  if (!isComplete) {
    elements.push({
      tag: "note",
      elements: [
        { tag: "plain_text", content: "⏳ Generating..." },
      ],
    });
  }

  const card: any = {
    config: { wide_screen_mode: true },
    elements,
  };

  return card;
}

/**
 * Build rich text (post) content for Feishu.
 */
export function buildFeishuRichTextContent(text: string): object {
  const blocks: Array<Array<{ tag: string; text?: string; language?: string }>> = [];
  const parts = text.split(/(```[\s\S]*?```)/g);

  for (const part of parts) {
    if (part.startsWith("```") && part.endsWith("```")) {
      const content = part.slice(3, -3);
      const firstNewline = content.indexOf("\n");
      const lang = firstNewline > 0 ? content.slice(0, firstNewline).trim() : "";
      const code = firstNewline > 0 ? content.slice(firstNewline + 1) : content;
      blocks.push([{ tag: "text", text: `[Code${lang ? ` (${lang})` : ""}]:\n${code}` }]);
    } else if (part.trim()) {
      blocks.push([{ tag: "text", text: part }]);
    }
  }

  return {
    msg_type: "post",
    content: JSON.stringify({
      post: {
        zh_cn: {
          title: "",
          content: blocks,
        },
      },
    }),
  };
}
