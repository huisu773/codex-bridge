import { splitMessage } from "../../utils/helpers.js";

const FEISHU_MAX_LEN = 30000;

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
 */
export function buildFeishuCard(text: string, title?: string, color?: string): object {
  // Feishu lark_md supports: **bold**, *italic*, ~~strike~~, [link](url),
  // `inline code`, and code blocks via markdown fence
  const elements: any[] = [];

  // Convert standard markdown to lark_md compatible format
  let larkText = markdownToLarkMd(text);

  // Split text into chunks that fit card element limits (~30k chars)
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
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: markdownToLarkMd(text),
      },
    });
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
