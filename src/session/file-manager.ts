import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { logger } from "../utils/logger.js";
import type { Session } from "./types.js";
import { getSessionFilesDir } from "../core/session-manager.js";

export function listSessionFiles(session: Session): string[] {
  const dir = getSessionFilesDir(session);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((name) => ({
    name,
    size: statSync(join(dir, name)).size,
    path: join(dir, name),
  })).map((f) => `${f.name} (${formatSize(f.size)})`);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function isTextFile(filePath: string): boolean {
  const textExts = new Set([
    ".txt", ".md", ".json", ".yaml", ".yml", ".toml", ".xml",
    ".html", ".css", ".js", ".ts", ".jsx", ".tsx", ".py",
    ".go", ".rs", ".rb", ".java", ".c", ".cpp", ".h", ".hpp",
    ".sh", ".bash", ".zsh", ".fish", ".conf", ".cfg", ".ini",
    ".env", ".sql", ".csv", ".log", ".gitignore", ".dockerfile",
  ]);
  return textExts.has(extname(filePath).toLowerCase());
}

export function readTextFile(filePath: string, maxSize = 100_000): string | null {
  try {
    const stat = statSync(filePath);
    if (stat.size > maxSize) return null;
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}
