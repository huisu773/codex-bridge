/**
 * Per-chat engine state — persisted via Session.engine field.
 *
 * Tracks which backend engine (codex or copilot) each chat uses.
 * Falls back to the configured default when no override exists.
 * Survives service restarts via session metadata persistence.
 */

import { config } from "../config.js";

export type EngineType = "codex" | "copilot";

// In-memory cache: fast lookups without hitting disk every time.
// Populated from Session.engine on loadSessionsFromDisk().
const overrides = new Map<string, EngineType>();

/** Get the active engine for a chat. */
export function getEngine(chatKey: string): EngineType {
  return overrides.get(chatKey) || config.engine;
}

/** Set the engine override for a chat (in-memory only — caller persists to session). */
export function setEngine(chatKey: string, engine: EngineType): void {
  if (engine === config.engine) {
    overrides.delete(chatKey); // Remove override when matching default
  } else {
    overrides.set(chatKey, engine);
  }
}

/**
 * Restore engine override from a persisted session.
 * Called during loadSessionsFromDisk() to rehydrate in-memory state.
 */
export function restoreEngine(chatKey: string, engine: EngineType | undefined): void {
  if (engine && engine !== config.engine) {
    overrides.set(chatKey, engine);
  }
}

/** Get the current engine label for display. */
export function getEngineLabel(chatKey: string): string {
  const engine = getEngine(chatKey);
  const isDefault = !overrides.has(chatKey);
  return `${engine}${isDefault ? " (default)" : ""}`;
}
