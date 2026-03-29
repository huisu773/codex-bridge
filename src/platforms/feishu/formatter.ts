import { splitMessage } from "../../utils/helpers.js";

const FEISHU_MAX_LEN = 30000; // Feishu text messages have a generous limit

export function formatFeishuReply(text: string): string[] {
  return splitMessage(text, FEISHU_MAX_LEN);
}

export function buildFeishuTextContent(text: string): object {
  return {
    msg_type: "text",
    content: JSON.stringify({ text }),
  };
}

export function buildFeishuRichTextContent(text: string): object {
  // Split code blocks and regular text
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
