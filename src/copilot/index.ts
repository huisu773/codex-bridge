/**
 * Copilot CLI integration — public API.
 *
 * All Copilot-specific code lives in src/copilot/.
 * Import from this barrel module to keep the rest of the codebase clean.
 */

export type {
  AskUserChoice,
  AskUserEvent,
  AskUserResponse,
  CopilotExecOptions,
  CopilotExecResult,
} from "./types.js";

export {
  executeCopilot,
  cancelAllCopilotTasks,
  getRunningCopilotCount,
} from "./executor.js";

export {
  hasPendingAskUser,
  waitForUserResponse,
  resolveUserResponse,
  cancelAllPendingAskUser,
} from "./pending-responses.js";

export {
  getEngine,
  setEngine,
  getEngineLabel,
  restoreEngine,
  type EngineType,
} from "./engine-state.js";
