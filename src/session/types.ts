export interface Session {
  id: string;
  platform: "telegram" | "feishu";
  chatId: string;
  userId: string;
  model: string;
  workingDir: string;
  sessionDir: string;
  codexSessionId?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  pendingFiles: string[];
  stats: {
    totalGeneratedFiles: number;
    totalReceivedFiles: number;
    totalTokensUsed: number;
  };
}

export interface ConversationEntry {
  timestamp: string;
  role: "user" | "assistant" | "system";
  content: string;
  files?: string[];
  metadata?: Record<string, unknown>;
}

export interface FileRecord {
  timestamp: string;
  type: "generated" | "received" | "sent";
  fileName: string;
  originalPath: string;
  sessionPath: string;
  size: number;
  platform: "telegram" | "feishu";
  description?: string;
}

// Keep backward compat alias
export type FileTransferRecord = FileRecord;
