import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
  rmSync,
  copyFileSync,
  renameSync,
  unlinkSync,
  statSync,
} from "node:fs";
import { join, basename, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { nowISO } from "../utils/helpers.js";
import { restoreEngine } from "../copilot/engine-state.js";
import type { Session, ConversationEntry, FileRecord } from "../session/types.js";

// In-memory session index: chatId → session
const activeSessions = new Map<string, Session>();

function sessionDir(sessionId: string): string {
  return join(config.session.dir, sessionId);
}

function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Session directory structure:
 *   {sessionDir}/
 *     meta.json          — session metadata
 *     conversation.jsonl  — full dialog log
 *     generated/          — files created by Codex during this session
 *     received/           — files uploaded by the user
 *     files.jsonl         — file operation records
 */
export function createSession(
  platform: "telegram" | "feishu",
  chatId: string,
  userId: string,
): Session {
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const hash = randomUUID().slice(0, 8);
  const id = `${dateStr}-${platform}-${hash}`;
  const dir = sessionDir(id);
  ensureDir(dir);
  ensureDir(join(dir, "generated"));
  ensureDir(join(dir, "received"));

  const session: Session = {
    id,
    platform,
    chatId,
    userId,
    model: config.codex.model,
    workingDir: config.codex.workingDir,
    isCustomWorkingDir: false,
    sessionDir: dir,
    createdAt: nowISO(),
    updatedAt: nowISO(),
    messageCount: 0,
    pendingFiles: [],
    stats: {
      totalGeneratedFiles: 0,
      totalReceivedFiles: 0,
      totalTokensUsed: 0,
    },
  };

  saveMeta(session);
  activeSessions.set(chatKey(platform, chatId), session);
  logger.info({ sessionId: id, platform, chatId, sessionDir: dir }, "Session created");
  return session;
}

function chatKey(platform: string, chatId: string): string {
  return `${platform}:${chatId}`;
}

function saveMeta(session: Session): void {
  const dir = sessionDir(session.id);
  ensureDir(dir);
  writeFileSync(join(dir, "meta.json"), JSON.stringify(session, null, 2));
}

export function getSession(
  platform: "telegram" | "feishu",
  chatId: string,
): Session | undefined {
  return activeSessions.get(chatKey(platform, chatId));
}

export function getOrCreateSession(
  platform: "telegram" | "feishu",
  chatId: string,
  userId: string,
): Session {
  const existing = getSession(platform, chatId);
  if (existing) return existing;
  return createSession(platform, chatId, userId);
}

export function deleteSession(
  platform: "telegram" | "feishu",
  chatId: string,
): boolean {
  const session = getSession(platform, chatId);
  if (!session) return false;
  activeSessions.delete(chatKey(platform, chatId));
  const dir = sessionDir(session.id);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
  logger.info({ sessionId: session.id }, "Session deleted");
  return true;
}

/**
 * Deactivate the current session without deleting its data from disk.
 * Used by /new to preserve old session history.
 */
export function deactivateSession(
  platform: "telegram" | "feishu",
  chatId: string,
): boolean {
  const session = getSession(platform, chatId);
  if (!session) return false;
  activeSessions.delete(chatKey(platform, chatId));
  logger.info({ sessionId: session.id }, "Session deactivated (data preserved)");
  return true;
}

export function updateSessionModel(
  session: Session,
  model: string,
): void {
  session.model = model;
  session.updatedAt = nowISO();
  saveMeta(session);
}

export function updateSessionWorkingDir(
  session: Session,
  workingDir: string,
): void {
  session.workingDir = workingDir;
  session.updatedAt = nowISO();
  saveMeta(session);
}

export function updateCodexSessionId(
  session: Session,
  codexSessionId: string,
): void {
  session.codexSessionId = codexSessionId;
  session.updatedAt = nowISO();
  saveMeta(session);
}

export function updateSessionEngine(
  session: Session,
  engine: "codex" | "copilot",
): void {
  session.engine = engine;
  session.updatedAt = nowISO();
  saveMeta(session);
}

export function updateCopilotSessionId(
  session: Session,
  copilotSessionId: string,
): void {
  session.copilotSessionId = copilotSessionId;
  session.updatedAt = nowISO();
  saveMeta(session);
}

export function appendConversation(
  session: Session,
  entry: ConversationEntry,
): void {
  const dir = sessionDir(session.id);
  ensureDir(dir);
  // Structured JSONL for programmatic access
  appendFileSync(
    join(dir, "conversation.jsonl"),
    JSON.stringify(entry) + "\n",
  );
  // Human-readable text log
  const roleLabel = entry.role === "user" ? "👤 You" : entry.role === "assistant" ? "🤖 Codex" : "⚙️ System";
  const filesNote = entry.files?.length ? `\n[Files: ${entry.files.join(", ")}]` : "";
  appendFileSync(
    join(dir, "conversation.txt"),
    `[${entry.timestamp}] ${roleLabel}:\n${entry.content}${filesNote}\n\n`,
  );
  session.messageCount++;
  session.updatedAt = nowISO();
  saveMeta(session);
}

export function getConversationHistory(sessionId: string): ConversationEntry[] {
  const file = join(sessionDir(sessionId), "conversation.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * Record a file operation and optionally copy the file into the session folder.
 */
export function recordFile(
  session: Session,
  record: FileRecord,
): void {
  const dir = sessionDir(session.id);
  ensureDir(dir);
  appendFileSync(
    join(dir, "files.jsonl"),
    JSON.stringify(record) + "\n",
  );
}

/**
 * Copy (or move) a generated file into the session's generated/ folder and record it.
 * When moveFile=true, the original is removed after copying to session.
 */
export function saveGeneratedFile(
  session: Session,
  originalPath: string,
  platform: "telegram" | "feishu",
  moveFile = false,
): FileRecord | null {
  try {
    if (!existsSync(originalPath)) return null;
    const stat = statSync(originalPath);
    if (!stat.isFile()) return null;
    const fileName = basename(originalPath);
    const destDir = join(sessionDir(session.id), "generated");
    ensureDir(destDir);
    const dest = join(destDir, fileName);
    copyFileSync(originalPath, dest);

    // Remove original if move mode (default workspace cleanup)
    if (moveFile) {
      try {
        unlinkSync(originalPath);
      } catch {
        // Ignore removal errors (e.g., permission issues)
      }
    }

    const record: FileRecord = {
      timestamp: nowISO(),
      type: "generated",
      fileName,
      originalPath,
      sessionPath: dest,
      size: stat.size,
      platform,
    };
    recordFile(session, record);
    session.stats.totalGeneratedFiles++;
    session.updatedAt = nowISO();
    saveMeta(session);
    return record;
  } catch (err) {
    logger.warn({ err, originalPath }, "Failed to save generated file");
    return null;
  }
}

/**
 * Save a file received from the user into the session's received/ folder.
 * Files are stored ONLY in the session directory (not in the global workingDir).
 * Codex accesses them via absolute path.
 */
export function saveReceivedFile(
  session: Session,
  fileName: string,
  buffer: Buffer,
  platform: "telegram" | "feishu",
): string {
  const destDir = join(sessionDir(session.id), "received");
  ensureDir(destDir);
  const dest = join(destDir, fileName);
  writeFileSync(dest, buffer);

  const record: FileRecord = {
    timestamp: nowISO(),
    type: "received",
    fileName,
    originalPath: "(uploaded)",
    sessionPath: dest,
    size: buffer.length,
    platform,
  };
  recordFile(session, record);
  session.stats.totalReceivedFiles++;
  // Track as pending so next Codex call includes file context (absolute path)
  if (!session.pendingFiles) session.pendingFiles = [];
  session.pendingFiles.push(dest);
  session.updatedAt = nowISO();
  saveMeta(session);
  return dest;
}

/**
 * Consume pending files: returns the list and clears it.
 */
export function consumePendingFiles(session: Session): string[] {
  const files = session.pendingFiles || [];
  session.pendingFiles = [];
  saveMeta(session);
  return files;
}

/**
 * Record a file sent to the user.
 */
export function recordFileSent(
  session: Session,
  filePath: string,
  platform: "telegram" | "feishu",
): void {
  try {
    const stat = existsSync(filePath) ? statSync(filePath) : null;
    const record: FileRecord = {
      timestamp: nowISO(),
      type: "sent",
      fileName: basename(filePath),
      originalPath: filePath,
      sessionPath: filePath,
      size: stat?.size || 0,
      platform,
    };
    recordFile(session, record);
  } catch (err) {
    logger.warn({ err, filePath }, "Failed to record file sent");
  }
}

// Keep backward compat exports
export function recordFileTransfer(session: Session, record: any): void {
  recordFile(session, {
    timestamp: record.timestamp,
    type: record.direction === "upload" ? "received" : "sent",
    fileName: record.fileName,
    originalPath: record.localPath,
    sessionPath: record.localPath,
    size: record.size,
    platform: record.platform,
  });
}

export function getSessionFilesDir(session: Session): string {
  const dir = join(sessionDir(session.id), "received");
  ensureDir(dir);
  return dir;
}

export function listAllSessions(): Session[] {
  const sessions: Session[] = [];
  if (!existsSync(config.session.dir)) return sessions;
  for (const name of readdirSync(config.session.dir)) {
    const metaFile = join(config.session.dir, name, "meta.json");
    if (existsSync(metaFile)) {
      try {
        const session = JSON.parse(readFileSync(metaFile, "utf-8")) as Session;
        // Backfill missing fields
        if (!session.sessionDir) session.sessionDir = sessionDir(session.id);
        if (!session.stats) session.stats = { totalGeneratedFiles: 0, totalReceivedFiles: 0, totalTokensUsed: 0 };
        if (session.isCustomWorkingDir === undefined) session.isCustomWorkingDir = false;
        sessions.push(session);
      } catch (err) {
        logger.warn({ err, metaFile }, "Skipping corrupted session metadata");
      }
    }
  }
  return sessions;
}

export function loadSessionsFromDisk(): void {
  const sessions = listAllSessions();
  for (const s of sessions) {
    activeSessions.set(chatKey(s.platform, s.chatId), s);
    // Restore per-chat engine override from persisted session
    if (s.engine) {
      restoreEngine(chatKey(s.platform, s.chatId), s.engine);
    }
  }
  logger.info({ count: sessions.length, dir: config.session.dir }, "Loaded sessions from disk");
}

export function cleanExpiredSessions(): number {
  const maxAge = config.session.maxAgeHours * 3600_000;
  const now = Date.now();
  let cleaned = 0;

  if (!existsSync(config.session.dir)) return 0;

  for (const name of readdirSync(config.session.dir)) {
    const dir = join(config.session.dir, name);
    const metaFile = join(dir, "meta.json");
    if (!existsSync(metaFile)) continue;

    try {
      const meta: Session = JSON.parse(readFileSync(metaFile, "utf-8"));
      const age = now - new Date(meta.updatedAt).getTime();
      if (age > maxAge) {
        activeSessions.delete(chatKey(meta.platform, meta.chatId));
        rmSync(dir, { recursive: true, force: true });
        cleaned++;
      }
    } catch (err) {
      logger.warn({ err, dir }, "Skipping corrupted session during cleanup");
    }
  }

  logger.info({ cleaned }, "Expired sessions cleaned");
  return cleaned;
}
