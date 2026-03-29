/**
 * Multi-round ask_user test for the Copilot executor.
 * Verifies that the forced interaction protocol keeps ask_user looping.
 *
 * Run: npx tsx test/test-copilot-multiround.ts
 */

process.env.TELEGRAM_BOT_TOKEN = "test:fake";
process.env.FEISHU_APP_ID = "test";
process.env.FEISHU_APP_SECRET = "test";
process.env.DEFAULT_ENGINE = "copilot";
process.env.COPILOT_MODEL = "claude-haiku-4.5";
process.env.LOG_LEVEL = "info";

import { executeCopilot } from "../src/copilot/executor.js";
import type { AskUserEvent, AskUserResponse } from "../src/copilot/types.js";

const MAX_ROUNDS = 3;

async function main() {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║  Multi-Round ask_user Test                   ║");
  console.log("╚══════════════════════════════════════════════╝\n");

  const rounds: { question: string; choices: string[]; selected: number }[] = [];
  let roundCount = 0;

  const result = await executeCopilot({
    prompt:
      "Analyze the codex-bridge project and suggest improvements. Start by asking me which area to focus on using ask_user.",
    model: "claude-haiku-4.5",
    workingDir: process.cwd(),
    timeoutMs: 180_000,
    onTextEvent: (text, _acc) => {
      if (text.length > 20) {
        console.log(`  📝 Text: ${text.slice(0, 120)}...`);
      }
    },
    onAskUser: async (event: AskUserEvent): Promise<AskUserResponse> => {
      roundCount++;
      console.log(`\n  ─── Round ${roundCount}/${MAX_ROUNDS} ───`);
      console.log(`  ❓ Q: "${event.question}"`);
      event.choices.forEach((c) => console.log(`     ${c.index}. ${c.text}`));

      const sel = (roundCount - 1) % event.choices.length;
      rounds.push({
        question: event.question,
        choices: event.choices.map((c) => c.text),
        selected: sel,
      });

      console.log(`  → Selecting #${sel + 1}: ${event.choices[sel]?.text}`);

      // After MAX_ROUNDS, cancel to stop the loop
      if (roundCount >= MAX_ROUNDS) {
        console.log(`\n  🛑 Reached ${MAX_ROUNDS} rounds, sending cancel to exit loop.`);
        return { type: "cancel" };
      }

      return { type: "choice", choiceIndex: sel };
    },
  });

  console.log("\n╔══════════════════════════════════════════════╗");
  console.log("║  RESULTS                                    ║");
  console.log("╚══════════════════════════════════════════════╝");

  console.log(`  Rounds completed: ${roundCount}`);
  console.log(`  Duration: ${Math.round(result.durationMs / 1000)}s`);
  console.log(`  Success: ${result.success}`);
  console.log(`  Output: ${result.output.slice(0, 200)}`);
  console.log(`  ask_user rounds (result): ${result.askUserRounds}`);

  if (roundCount >= 2) {
    console.log("\n  ✅ Multi-round ask_user WORKS — forced protocol active");
    console.log(`  💰 ${roundCount} rounds, 1 premium request consumed`);
  } else {
    console.log("\n  ⚠️ Only 1 round — forced protocol may not be working");
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
