/**
 * Per-chat engine state (in-memory, not persisted).
 *
 * Tracks which backend engine (codex or copilot) each chat uses.
 * Falls back to the configured default when no override exists.
 * Resets to default on service restart.
 */

import { config } from "../config.js";

export type EngineType = "codex" | "copilot";

const overrides = new Map<string, EngineType>();

/** Get the active engine for a chat. */
export function getEngine(chatKey: string): EngineType {
  return overrides.get(chatKey) || config.engine;
}

/** Set the engine override for a chat. */
export function setEngine(chatKey: string, engine: EngineType): void {
  if (engine === config.engine) {
    overrides.delete(chatKey); // Remove override when matching default
  } else {
    overrides.set(chatKey, engine);
  }
}

/** Get the current engine label for display. */
export function getEngineLabel(chatKey: string): string {
  const engine = getEngine(chatKey);
  const isDefault = !overrides.has(chatKey);
  return `${engine}${isDefault ? " (default)" : ""}`;
}
