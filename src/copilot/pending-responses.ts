/**
 * Per-chat ask_user response queue.
 *
 * When the Copilot executor detects an ask_user event, it registers a pending
 * response entry. The next incoming IM message for that chat resolves the
 * pending promise instead of spawning a new execution.
 *
 * This MUST be checked BEFORE the chat task queue to avoid deadlocks.
 */

import type { AskUserResponse } from "./types.js";
import { logger } from "../utils/logger.js";

interface PendingEntry {
  resolve: (response: AskUserResponse) => void;
  timeoutId: NodeJS.Timeout;
  question: string; // for logging
}

const pending = new Map<string, PendingEntry>();

/** Check if a chat has a pending ask_user waiting for a response. */
export function hasPendingAskUser(chatKey: string): boolean {
  return pending.has(chatKey);
}

/**
 * Register a pending ask_user and wait for the user's response.
 * Returns a Promise that resolves when the user responds or times out.
 */
export function waitForUserResponse(
  chatKey: string,
  timeoutMs: number,
  question: string,
): Promise<AskUserResponse> {
  return new Promise((resolve) => {
    // Cancel any existing pending for this chat
    cancelPending(chatKey);

    const timeoutId = setTimeout(() => {
      pending.delete(chatKey);
      logger.info({ chatKey, question: question.slice(0, 60) }, "ask_user timed out");
      resolve({ type: "timeout" });
    }, timeoutMs);

    pending.set(chatKey, { resolve, timeoutId, question });
  });
}

/**
 * Resolve a pending ask_user with the user's raw text message.
 * Parses the text as a choice number or freeform input.
 * Returns true if a pending entry existed and was resolved.
 */
export function resolveUserResponse(chatKey: string, rawText: string): boolean {
  const entry = pending.get(chatKey);
  if (!entry) return false;

  clearTimeout(entry.timeoutId);
  pending.delete(chatKey);

  const trimmed = rawText.trim();
  const num = parseInt(trimmed, 10);

  if (!isNaN(num) && num >= 1) {
    logger.info({ chatKey, choice: num }, "ask_user resolved with choice");
    entry.resolve({ type: "choice", choiceIndex: num - 1 }); // 0-based
  } else {
    logger.info({ chatKey, text: trimmed.slice(0, 60) }, "ask_user resolved with freeform");
    entry.resolve({ type: "freeform", text: trimmed });
  }

  return true;
}

function cancelPending(chatKey: string): void {
  const entry = pending.get(chatKey);
  if (entry) {
    clearTimeout(entry.timeoutId);
    pending.delete(chatKey);
  }
}

/** Cancel all pending ask_user entries (used during shutdown). */
export function cancelAllPendingAskUser(): void {
  for (const [, entry] of pending) {
    clearTimeout(entry.timeoutId);
    entry.resolve({ type: "cancel" });
  }
  pending.clear();
}
