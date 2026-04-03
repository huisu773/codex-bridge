/**
 * Unified engine execution interfaces.
 *
 * Both Codex and Copilot executors implement these types so that
 * callers (commands, passthrough handler) can be engine-agnostic.
 */

export type EngineName = "codex" | "copilot" | "claude";

/** Options shared by all engine executors. */
export interface EngineExecOptions {
  prompt: string;
  model?: string;
  workingDir?: string;
  images?: string[];
  timeoutMs?: number;
  resumeSessionId?: string;
  /** Streaming: called with each text chunk as it arrives. */
  onProgress?: (chunk: string) => void;
  /** Streaming: called with (delta, accumulated) on each text event. */
  onTextEvent?: (text: string, accumulated: string) => void;
  /** Codex-only: called immediately when thread ID becomes available. */
  onSessionStarted?: (sessionId: string) => void;
}

/** Result returned by all engine executors. */
export interface EngineExecResult {
  success: boolean;
  output: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  newFiles: string[];
  /** Engine-specific session/thread ID for multi-turn resume. */
  sessionId?: string;
  /** Token usage (Codex only). */
  usage?: { inputTokens: number; outputTokens: number; cachedTokens: number };
}

/** Interface that every engine executor must implement. */
export interface EngineExecutor {
  readonly name: EngineName;
  execute(opts: EngineExecOptions): Promise<EngineExecResult>;
  cancelAll(): number;
  getRunningCount(): number;
  /** Return a curated list of known models for this engine. */
  listModels(): EngineModelInfo[];
}

/** Model metadata returned by listModels(). */
export interface EngineModelInfo {
  id: string;
  description?: string;
  recommended?: boolean;
}
