/**
 * Extract clean assistant text from Copilot CLI PTY output.
 *
 * Filters out:
 * - ask_user boxes (╭...╯)
 * - Tool execution spinners (●/◉/◎/○/◐ Running...)
 * - Banner art and status lines
 * - Input prompt / status bar
 */

import { stripAnsi } from "./ansi-utils.js";

/**
 * Extract the assistant's text response from raw PTY output,
 * removing all TUI artifacts.
 */
export function extractAssistantText(rawOutput: string): string {
  const clean = stripAnsi(rawOutput);

  // Remove ask_user boxes (╭...╯ blocks)
  const withoutBoxes = clean.replace(/╭[^╯]*╯/gs, "");

  // Remove tool status lines (spinner indicators)
  const withoutTools = withoutBoxes.replace(
    /[●◉◎○◐]\s+.*/g,
    "",
  );

  // Remove prompt/status bar lines
  const withoutPrompt = withoutTools.replace(
    /shift\+tab.+|Remaining reqs\..*/g,
    "",
  );

  // Remove selection markers
  const withoutMarkers = withoutPrompt.replace(/❯\s+.*/g, "");

  // Remove banner/logo and box-drawing fragments
  const withoutBanner = withoutMarkers.replace(
    /[░▒▓█▄▀╔╗╚╝║═┌┐└┘├┤┬┴┼╭╮╰╯│─]{2,}.*/g,
    "",
  );

  // Remove lines that are only box-drawing chars, spaces, or choice numbers
  const withoutBoxLines = withoutBanner.replace(
    /^[\s│─╭╮╰╯┌┐└┘├┤┬┴┼║═]*$/gm,
    "",
  );

  // Remove numbered choice lines (from ask_user rendering residue)
  const withoutChoices = withoutBoxLines.replace(
    /^\s*\d+\.\s+\S.{0,60}$/gm,
    "",
  );

  // Collapse excessive whitespace but preserve paragraph breaks
  const collapsed = withoutChoices
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return collapsed;
}
