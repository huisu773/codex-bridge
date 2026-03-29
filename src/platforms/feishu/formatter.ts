import { splitMessage } from "../../utils/helpers.js";

const FEISHU_MAX_LEN = 30000;

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

  // Split text into chunks that fit card element limits (~30k chars)
  if (text.length > FEISHU_MAX_LEN) {
    text = text.slice(0, FEISHU_MAX_LEN - 10) + "\n...";
  }

  elements.push({
    tag: "div",
    text: {
      tag: "lark_md",
      content: text,
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
        content: text,
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
