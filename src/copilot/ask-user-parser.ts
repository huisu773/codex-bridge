/**
 * Parser for Copilot CLI's ask_user TUI rendered via PTY.
 *
 * ask_user renders as a Unicode box:
 *   ╭──────────────╮
 *   │ Question     │
 *   │ ──────────── │
 *   │ ❯ 1. Opt A   │
 *   │   2. Opt B   │
 *   │   3. Opt C   │
 *   │ hint line    │
 *   ╰──────────────╯
 *
 * Each row is individually positioned via ANSI cursor commands.
 * After stripping ANSI, content is concatenated with │ separators.
 */

import { stripAnsi } from "./ansi-utils.js";
import type { AskUserChoice } from "./types.js";

export interface ParsedAskUser {
  question: string;
  choices: AskUserChoice[];
  selectedIndex: number;
  hasFreeform: boolean;
  hintLine: string;
}

/**
 * Detect whether an ask_user box is currently visible in the PTY output.
 * Checks for the combination of box-drawing chars + selection marker + hint text.
 */
export function isAskUserVisible(rawOutput: string): boolean {
  const clean = stripAnsi(rawOutput);
  return (
    clean.includes("╭") &&
    clean.includes("╯") &&
    clean.includes("❯") &&
    /to select|Enter to confirm/i.test(clean)
  );
}

/**
 * Parse the ask_user box from raw PTY output.
 * Returns null if no valid ask_user box is found.
 */
export function parseAskUserFromRaw(rawOutput: string): ParsedAskUser | null {
  const clean = stripAnsi(rawOutput);

  // Find the LAST box occurrence (the active one)
  const lastBoxStart = clean.lastIndexOf("╭");
  const lastBoxEnd = clean.lastIndexOf("╯");

  if (lastBoxStart < 0 || lastBoxEnd < 0 || lastBoxEnd <= lastBoxStart) {
    return null;
  }

  const boxContent = clean.slice(lastBoxStart, lastBoxEnd + 1);

  // Split by │ (cell separator) and clean up box-drawing chars
  const cells = boxContent
    .split(/[│]/)
    .map((s) => s.replace(/[╭╮╰╯─]/g, "").trim())
    .filter((s) => s.length > 0);

  if (cells.length < 2) return null;

  let question = "";
  const choices: (AskUserChoice & { selected: boolean })[] = [];
  let hintLine = "";
  let hasFreeform = false;

  for (const cell of cells) {
    // Choice line: starts with ❯ (selected) or spaces + digit
    const choiceMatch = cell.match(/^(❯\s*)?(\d+)\.\s+(.+)/);
    if (choiceMatch) {
      choices.push({
        index: parseInt(choiceMatch[2], 10),
        text: choiceMatch[3].trim(),
        selected: !!choiceMatch[1],
      });
      if (/other|type your answer|自由输入|其他/i.test(choiceMatch[3])) {
        hasFreeform = true;
      }
      continue;
    }

    // Hint line (navigation instructions)
    if (/to select|Enter to confirm|Esc to cancel|↑↓/i.test(cell)) {
      hintLine = cell;
      continue;
    }

    // Separator line (all dashes/spaces)
    if (/^[─ ]{3,}$/.test(cell)) continue;

    // Otherwise it's the question text (take the first substantive one)
    if (!question && cell.length > 3) {
      question = cell;
    }
  }

  if (choices.length === 0) return null;

  const selectedIdx = choices.findIndex((c) => c.selected);

  return {
    question,
    choices: choices.map((c) => ({ index: c.index, text: c.text })),
    selectedIndex: selectedIdx >= 0 ? selectedIdx : 0,
    hasFreeform,
    hintLine,
  };
}
