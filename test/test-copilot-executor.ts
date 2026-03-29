/**
 * End-to-end test for the Copilot CLI PTY executor.
 *
 * Tests the full flow:
 * 1. Spawns copilot -i via PTY
 * 2. Detects ask_user events
 * 3. Auto-selects choices via simulated keystrokes
 * 4. Extracts assistant text
 *
 * Run: npx tsx test/test-copilot-executor.ts
 */

// Inline config override BEFORE importing anything
process.env.TELEGRAM_BOT_TOKEN = "test:fake";
process.env.FEISHU_APP_ID = "test";
process.env.FEISHU_APP_SECRET = "test";
process.env.DEFAULT_ENGINE = "copilot";
process.env.COPILOT_MODEL = "claude-haiku-4.5";
process.env.LOG_LEVEL = "debug";

import { executeCopilot } from "../src/copilot/executor.js";
import type { AskUserEvent, AskUserResponse } from "../src/copilot/types.js";

async function main() {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║  Copilot Executor — End-to-End Test         ║");
  console.log("╚══════════════════════════════════════════════╝\n");

  const askUserLog: { question: string; choices: string[]; selected: number }[] = [];
  const textEvents: string[] = [];

  const result = await executeCopilot({
    prompt:
      "Use ask_user to ask me: What programming language should we use? Choices: TypeScript, Python, Rust",
    model: "claude-haiku-4.5",
    workingDir: process.cwd(),
    timeoutMs: 120_000,
    onProgress: (_chunk) => {
      // Silence progress for cleaner test output
    },
    onTextEvent: (text, _accumulated) => {
      textEvents.push(text);
      console.log(`  📝 [TextEvent] ${text.slice(0, 100)}...`);
    },
    onAskUser: async (event: AskUserEvent): Promise<AskUserResponse> => {
      console.log(`\n  ❓ [ask_user] Q: "${event.question}"`);
      console.log(`     Choices: ${event.choices.map((c) => c.text).join(" | ")}`);

      const selection = askUserLog.length === 0 ? 1 : 0; // Pick 2nd option first, then 1st
      askUserLog.push({
        question: event.question,
        choices: event.choices.map((c) => c.text),
        selected: selection,
      });

      console.log(`     → Auto-selecting: ${event.choices[selection]?.text || "first"}`);
      return { type: "choice", choiceIndex: selection };
    },
  });

  // ─── Report ──────────────────────────────────────────────
  console.log("\n╔══════════════════════════════════════════════╗");
  console.log("║  TEST RESULTS                               ║");
  console.log("╚══════════════════════════════════════════════╝");

  console.log(`\n  Success:        ${result.success ? "✅" : "❌"} (${result.success})`);
  console.log(`  Exit code:      ${result.exitCode}`);
  console.log(`  Duration:       ${Math.round(result.durationMs / 1000)}s`);
  console.log(`  Timed out:      ${result.timedOut}`);
  console.log(`  ask_user rounds: ${result.askUserRounds}`);
  console.log(`  Output length:  ${result.output.length} chars`);

  console.log(`\n  ask_user log:`);
  for (const entry of askUserLog) {
    console.log(`    Q: "${entry.question.slice(0, 60)}"`);
    console.log(`    Choices: ${entry.choices.join(" | ")}`);
    console.log(`    Selected: #${entry.selected + 1}`);
  }

  console.log(`\n  Output preview:`);
  console.log(`    ${result.output.slice(0, 300)}`);

  // ─── Assertions ──────────────────────────────────────────
  const passed: string[] = [];
  const failed: string[] = [];

  function assert(label: string, condition: boolean) {
    if (condition) {
      passed.push(label);
      console.log(`  ✅ ${label}`);
    } else {
      failed.push(label);
      console.log(`  ❌ ${label}`);
    }
  }

  console.log("\n  Assertions:");
  assert("Execution succeeded", result.success);
  assert("At least 1 ask_user round", result.askUserRounds >= 1);
  assert("ask_user callback was invoked", askUserLog.length >= 1);
  assert("Output is non-empty", result.output.length > 10);
  assert("Did not time out", !result.timedOut);

  console.log(`\n  Results: ${passed.length} passed, ${failed.length} failed`);

  if (failed.length > 0) {
    console.log("\n  ⚠️ SOME TESTS FAILED");
    process.exit(1);
  } else {
    console.log("\n  🎉 ALL TESTS PASSED");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
