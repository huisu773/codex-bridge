/**
 * Multi-round ask_user test for the Copilot executor with --autopilot.
 * Verifies that the forced interaction protocol (via --autopilot) handles ask_user.
 *
 * With --autopilot, Copilot CLI automatically answers ask_user prompts.
 * This test verifies the session tracking for multi-turn conversations.
 *
 * Run: npx tsx test/test-copilot-multiround.ts
 */

process.env.TELEGRAM_BOT_TOKEN = "test:fake";
process.env.FEISHU_APP_ID = "test";
process.env.FEISHU_APP_SECRET = "test";
process.env.DEFAULT_ENGINE = "copilot";
process.env.COPILOT_MODEL = "claude-haiku-4.5";
process.env.LOG_LEVEL = "info";

import { copilotEngine } from "../src/engines/copilot.js";
const executeCopilot = copilotEngine.execute.bind(copilotEngine);

async function main() {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║  Multi-Round Autopilot Test                  ║");
  console.log("╚══════════════════════════════════════════════╝\n");

  let askUserRoundsTotal = 0;
  const sessions: (string | undefined)[] = [];

  // First turn: ask a question that might trigger ask_user with --autopilot
  console.log("═══ Turn 1: Initial Request ═══\n");
  const result1 = await executeCopilot({
    prompt:
      "Should I use TypeScript or Python for this project? Please use ask_user to get my input.",
    model: "claude-haiku-4.5",
    workingDir: process.cwd(),
    timeoutMs: 60_000,
    onTextEvent: (text, _acc) => {
      if (text.length > 50) {
        console.log(`  📝 Text: ${text.slice(0, 100)}...`);
      }
    },
  });

  console.log(`\n  Duration: ${Math.round(result1.durationMs / 1000)}s`);
  console.log(`  Success: ${result1.success}`);
  console.log(`  ask_user rounds: ${result1.askUserRounds}`);
  console.log(`  SessionId: ${result1.sessionId}`);

  askUserRoundsTotal += result1.askUserRounds;
  sessions.push(result1.sessionId);

  // Second turn: resume the session and ask a follow-up
  if (result1.sessionId) {
    console.log("\n═══ Turn 2: Resume Session ═══\n");
    const result2 = await executeCopilot({
      prompt: "Given your previous response, what are the main pros and cons of that choice?",
      model: "claude-haiku-4.5",
      workingDir: process.cwd(),
      timeoutMs: 60_000,
      resumeSessionId: result1.sessionId,
      onTextEvent: (text, _acc) => {
        if (text.length > 50) {
          console.log(`  📝 Text: ${text.slice(0, 100)}...`);
        }
      },
    });

    console.log(`\n  Duration: ${Math.round(result2.durationMs / 1000)}s`);
    console.log(`  Success: ${result2.success}`);
    console.log(`  ask_user rounds: ${result2.askUserRounds}`);
    console.log(`  SessionId: ${result2.sessionId}`);

    askUserRoundsTotal += result2.askUserRounds;
    sessions.push(result2.sessionId);
  }

  console.log("\n╔══════════════════════════════════════════════╗");
  console.log("║  RESULTS                                    ║");
  console.log("╚══════════════════════════════════════════════╝");

  console.log(`  Total ask_user rounds: ${askUserRoundsTotal}`);
  console.log(`  Sessions captured: ${sessions.filter(Boolean).length}`);
  console.log(`  Session IDs preserved: ${sessions[0] === sessions[1] ? "✅ Yes" : "⚠️ Different"}`);

  if (sessions.every((s) => !!s)) {
    console.log("\n  ✅ Multi-round with --autopilot WORKS");
    console.log("  📍 Sessions correctly tracked for resumption");
  } else {
    console.log("\n  ⚠️ Some sessions not captured");
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
