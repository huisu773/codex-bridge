/**
 * Copilot CLI PTY integration — Type definitions
 */

export interface AskUserChoice {
  index: number;
  text: string;
}

export interface AskUserEvent {
  question: string;
  choices: AskUserChoice[];
  hasFreeform: boolean;
  hintLine: string;
}

export interface AskUserResponse {
  type: "choice" | "freeform" | "timeout" | "cancel";
  choiceIndex?: number;
  text?: string;
}

export interface CopilotExecOptions {
  prompt: string;
  model?: string;
  workingDir?: string;
  timeoutMs?: number;
  resumeSessionId?: string; // Pass to --resume for multi-turn
  onProgress?: (chunk: string) => void;
  onTextEvent?: (text: string, accumulated: string) => void;
}

export interface CopilotExecResult {
  success: boolean;
  output: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  newFiles: string[];
  askUserRounds: number;
  sessionId?: string; // Copilot session ID for --resume multi-turn
}
