import { readFileSync } from "node:fs";

const MAX_SCAN_BYTES = 1024 * 1024; // 1MB

const SENSITIVE_CONTENT_PATTERNS: RegExp[] = [
  /(?:api[_-]?key|secret|token|password|passwd|private[_-]?key)\s*[:=]\s*["']?[^\s"'`]{8,}/i,
  /(?:sk|pk)-[a-zA-Z0-9_-]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /Bearer\s+[a-zA-Z0-9._-]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

function isLikelyBinary(buf: Buffer): boolean {
  // Null bytes are a strong signal this is binary content.
  const sampleLen = Math.min(buf.length, 2048);
  for (let i = 0; i < sampleLen; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export function hasSensitiveContent(filePath: string): boolean {
  try {
    const raw = readFileSync(filePath);
    if (raw.length === 0 || isLikelyBinary(raw)) return false;

    const text = raw.subarray(0, MAX_SCAN_BYTES).toString("utf8");
    return SENSITIVE_CONTENT_PATTERNS.some((pattern) => pattern.test(text));
  } catch {
    return false;
  }
}

