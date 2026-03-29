import { logger } from "../utils/logger.js";
import { config } from "../config.js";

export function isAuthorizedTelegram(userId: number): boolean {
  if (config.telegram.allowedUserIds.length === 0) return true; // No whitelist = allow all (dev mode)
  return config.telegram.allowedUserIds.includes(userId);
}

export function isAuthorizedFeishu(userId: string): boolean {
  if (config.feishu.allowedUserIds.length === 0) return true;
  return config.feishu.allowedUserIds.includes(userId);
}

// Simple in-memory rate limiter
const requestCounts = new Map<string, { count: number; resetAt: number }>();

export function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const limit = config.security.rateLimitPerMinute;
  const entry = requestCounts.get(userId);

  if (!entry || now > entry.resetAt) {
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
