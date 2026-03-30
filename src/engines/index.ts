/**
 * Engine registry and factory.
 *
 * Provides a unified interface for executing prompts against
 * either the Codex or Copilot backend engine.
 */

import { config } from "../config.js";
import { codexEngine } from "./codex.js";
import { copilotEngine } from "./copilot.js";
import type { EngineName, EngineExecutor, EngineExecOptions, EngineExecResult } from "./types.js";

export type { EngineName, EngineExecOptions, EngineExecResult, EngineExecutor } from "./types.js";

// ─── Per-chat engine overrides ────────────────────────────────────────────

const engineOverrides = new Map<string, EngineName>();

export function getEngine(chatKey: string): EngineName {
  return engineOverrides.get(chatKey) || config.engine;
}

export function setEngine(chatKey: string, engine: EngineName): void {
  engineOverrides.set(chatKey, engine);
}

export function clearEngine(chatKey: string): void {
  engineOverrides.delete(chatKey);
}

/** Get the current engine label for display. */
export function getEngineLabel(chatKey: string): string {
  const engine = getEngine(chatKey);
  const isDefault = !engineOverrides.has(chatKey);
  return `${engine}${isDefault ? " (default)" : ""}`;
}

/** Restore per-chat engine overrides from persisted sessions. */
export function restoreEngineOverride(chatKey: string, engine: EngineName): void {
  if (engine !== config.engine) {
    engineOverrides.set(chatKey, engine);
  }
}

// ─── Engine resolution ────────────────────────────────────────────────────

const engines: Record<EngineName, EngineExecutor> = {
  codex: codexEngine,
  copilot: copilotEngine,
};

/** Get the executor for a given engine name. */
export function getExecutor(engine: EngineName): EngineExecutor {
  return engines[engine];
}

/** Execute a prompt using the engine assigned to a chat. */
export async function executeForChat(
  chatKey: string,
  opts: EngineExecOptions,
): Promise<EngineExecResult> {
  const engine = getEngine(chatKey);
  return engines[engine].execute(opts);
}

/** Cancel all running tasks across all engines. Returns total cancelled. */
export function cancelAllEngines(): { codex: number; copilot: number } {
  return {
    codex: codexEngine.cancelAll(),
    copilot: copilotEngine.cancelAll(),
  };
}

/** Get total running task count across all engines. */
export function getTotalRunningCount(): number {
  return codexEngine.getRunningCount() + copilotEngine.getRunningCount();
}
