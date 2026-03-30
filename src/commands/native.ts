/**
 * Native command registration — thin orchestrator.
 *
 * Delegates to session-commands.ts and passthrough.ts for the actual implementations.
 */

import { registerSessionCommands } from "./session-commands.js";
import { registerPassthroughCommand } from "./passthrough.js";

export function registerNativeCommands(): void {
  registerSessionCommands();
  registerPassthroughCommand();
}
