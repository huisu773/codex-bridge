export interface PlatformMessage {
  platform: "telegram" | "feishu";
  userId: string;
  chatId: string;
  text: string;
  files?: PlatformFile[];
  replyToMessageId?: string;
}

export interface PlatformFile {
  name: string;
  mimeType?: string;
  size?: number;
  getBuffer: () => Promise<Buffer>;
}

export interface PlatformReply {
  text?: string;
  files?: { path: string; name: string }[];
  cards?: unknown; // Feishu card message
}

export interface PlatformAdapter {
  readonly platform: "telegram" | "feishu";
  sendText(chatId: string, text: string, replyTo?: string): Promise<void>;
  sendFile(chatId: string, filePath: string, caption?: string): Promise<void>;
  sendTyping(chatId: string): Promise<void>;
}
