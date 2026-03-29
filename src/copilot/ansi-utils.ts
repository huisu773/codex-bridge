/**
 * ANSI escape sequence utilities for PTY output processing.
 *
 * Copilot CLI's `--no-color` flag reduces but does NOT eliminate ANSI sequences.
 * Cursor positioning, alt-screen switches, and control codes still appear.
 */

// Matches CSI sequences, OSC sequences, charset selectors, and mode switches
const ANSI_RE =
  /\x1B(?:\[[0-9;?]*[a-zA-Z]|\].*?(?:\x07|\x1B\\)|\([A-Z]|[=>])/g;

// Non-printable control characters (except newline \x0A and carriage return \x0D)
const CTRL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/** Strip all ANSI escape sequences and control characters from PTY output. */
export function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, "").replace(CTRL_RE, "");
}
