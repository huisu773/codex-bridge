import { logger } from "../utils/logger.js";
import { config } from "../config.js";

// Startup security check: warn about empty whitelists
const emptyPlatforms: string[] = [];
if (config.telegram.allowedUserIds.length === 0) emptyPlatforms.push("Telegram");
if (config.feishu.allowedUserIds.length === 0) emptyPlatforms.push("Feishu");
if (emptyPlatforms.length > 0) {
  if (process.env.ALLOW_EMPTY_WHITELIST === "yes") {
    logger.warn({ platforms: emptyPlatforms }, "⚠️ Empty whitelist — ALL users allowed (ALLOW_EMPTY_WHITELIST=yes)");
  } else {
    logger.error(
      { platforms: emptyPlatforms },
      "🔒 Empty whitelist detected. Users on these platforms will be DENIED. Set ALLOW_EMPTY_WHITELIST=yes or configure allowed user IDs.",
    );
  }
}

export function isAuthorizedTelegram(userId: number): boolean {
  if (config.telegram.allowedUserIds.length === 0) {
    return process.env.ALLOW_EMPTY_WHITELIST === "yes";
  }
  return config.telegram.allowedUserIds.includes(userId);
}

export function isAuthorizedFeishu(userId: string): boolean {
  if (config.feishu.allowedUserIds.length === 0) {
    return process.env.ALLOW_EMPTY_WHITELIST === "yes";
  }
  return config.feishu.allowedUserIds.includes(userId);
}

// Simple in-memory rate limiter with bounded map
const MAX_RATE_LIMIT_ENTRIES = 10_000;
const requestCounts = new Map<string, { count: number; resetAt: number }>();

function pruneExpiredEntries(): void {
  const now = Date.now();
  for (const [key, entry] of requestCounts) {
    if (now > entry.resetAt) requestCounts.delete(key);
  }
}

export function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const limit = config.security.rateLimitPerMinute;
  const entry = requestCounts.get(userId);

  if (!entry || now > entry.resetAt) {
    // Evict expired entries if approaching capacity
    if (requestCounts.size >= MAX_RATE_LIMIT_ENTRIES) {
      pruneExpiredEntries();
      if (requestCounts.size >= MAX_RATE_LIMIT_ENTRIES) {
        logger.warn({ size: requestCounts.size }, "Rate limit map at capacity after prune");
        return false;
      }
    }
    requestCounts.set(userId, { count: 1, resetAt: now + 60_000 });
    return true;
  }

  if (entry.count >= limit) {
    logger.warn({ userId, count: entry.count }, "Rate limit exceeded");
    return false;
  }

  entry.count++;
  return true;
}

// Prune expired entries every minute
setInterval(pruneExpiredEntries, 60_000);

export function sanitizeInput(input: string): string {
  // Remove null bytes and control characters (except newlines/tabs)
  return input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}

export function filterSensitiveOutput(output: string): string {
  // Mask patterns that look like API keys, tokens, passwords
  return output
    .replace(/(?:sk-|pk-|key-|token-)[a-zA-Z0-9_-]{20,}/g, "[REDACTED_KEY]")
    .replace(/(?:password|passwd|secret|token)\s*[:=]\s*[^\s]{8,}/gi, "$1=[REDACTED]")
    .replace(/Bearer\s+[a-zA-Z0-9._-]{20,}/g, "Bearer [REDACTED]");
}
