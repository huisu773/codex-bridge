import { logger } from "./logger.js";

/**
 * Retry an async function with exponential backoff.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { maxAttempts?: number; baseDelayMs?: number; label?: string } = {},
): Promise<T> {
  const { maxAttempts = 3, baseDelayMs = 1000, label = "operation" } = opts;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxAttempts) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        logger.warn({ attempt, maxAttempts, delay, label, error: lastError.message }, "Retrying after error");
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw lastError;
}
