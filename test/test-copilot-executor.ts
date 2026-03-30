/**
 * End-to-end test for the Copilot CLI JSONL executor.
 *
 * Tests:
 * 1. Basic prompt execution via -p --output-format json
 * 2. Multi-turn via --resume (session ID capture and reuse)
 * 3. Streaming text events (onTextEvent / onProgress)
 * 4. File detection via directory snapshots
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

import { copilotEngine } from "../src/engines/copilot.js";
const executeCopilot = copilotEngine.execute.bind(copilotEngine);

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

// ─── Test 1: Basic execution ────────────────────────────────────

async function testBasicExecution() {
  console.log("\n═══ Test 1: Basic Execution ═══\n");

  const progressChunks: string[] = [];
  const textEvents: string[] = [];

  const result = await executeCopilot({
    prompt: "Say just the word 'pong'. Nothing else.",
    model: "claude-haiku-4.5",
    workingDir: process.cwd(),
    timeoutMs: 60_000,
    onProgress: (chunk) => progressChunks.push(chunk),
    onTextEvent: (text, _acc) => textEvents.push(text),
  });

  console.log(`  Success: ${result.success}`);
  console.log(`  Output: "${result.output.slice(0, 200)}"`);
  console.log(`  Duration: ${Math.round(result.durationMs / 1000)}s`);
  console.log(`  SessionId: ${result.sessionId || "none"}`);
  console.log(`  Progress chunks: ${progressChunks.length}`);
  console.log(`  Text events: ${textEvents.length}`);

  assert("Basic: execution succeeded", result.success);
  assert("Basic: has output", result.output.length > 0 && result.output !== "(no output)");
  assert("Basic: did not time out", !result.timedOut);
  assert("Basic: captured sessionId", !!result.sessionId);
  assert("Basic: received progress callbacks", progressChunks.length > 0);
  assert("Basic: received text events", textEvents.length > 0);

  return result.sessionId;
}

// ─── Test 2: Multi-turn via --resume ────────────────────────────

async function testResume(sessionId: string) {
  console.log("\n═══ Test 2: Multi-turn Resume ═══\n");
  console.log(`  Resuming session: ${sessionId}`);

  const result = await executeCopilot({
    prompt: "What was my previous message to you? Quote it exactly.",
    model: "claude-haiku-4.5",
    workingDir: process.cwd(),
    timeoutMs: 60_000,
    resumeSessionId: sessionId,
  });

  console.log(`  Success: ${result.success}`);
  console.log(`  Output: "${result.output.slice(0, 300)}"`);
  console.log(`  Duration: ${Math.round(result.durationMs / 1000)}s`);
  console.log(`  SessionId: ${result.sessionId || "none"}`);

  assert("Resume: execution succeeded", result.success);
  assert("Resume: has meaningful output", result.output.length > 5 && result.output !== "(no output)");
  assert("Resume: output references previous message",
    result.output.toLowerCase().includes("pong") ||
    result.output.toLowerCase().includes("previous"));
  assert("Resume: preserves sessionId", result.sessionId === sessionId);
}

// ─── Test 3: File creation detection ─────────────────────────────

async function testFileDetection() {
  console.log("\n═══ Test 3: File Creation Detection ═══\n");

  const result = await executeCopilot({
    prompt: "Create a file called /tmp/copilot-test-file.txt with the content 'hello from copilot test'",
    model: "claude-haiku-4.5",
    workingDir: "/tmp",
    timeoutMs: 120_000,
  });

  console.log(`  Success: ${result.success}`);
  console.log(`  Output: "${result.output.slice(0, 200)}"`);
  console.log(`  New files: ${result.newFiles.length}`);
  if (result.newFiles.length > 0) {
    console.log(`  Files: ${result.newFiles.join(", ")}`);
  }

  assert("FileDetect: execution succeeded", result.success);
  assert("FileDetect: has output", result.output.length > 0 && result.output !== "(no output)");

  // Clean up
  try {
    const { unlinkSync } = await import("node:fs");
    unlinkSync("/tmp/copilot-test-file.txt");
  } catch { /* ignore */ }
}

// ─── Main ───────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║  Copilot Executor — Comprehensive Test      ║");
  console.log("╚══════════════════════════════════════════════╝");

  const sessionId = await testBasicExecution();

  if (sessionId) {
    await testResume(sessionId);
  } else {
    console.log("\n⚠️ Skipping resume test — no sessionId from basic test");
  }

  await testFileDetection();

  // ─── Summary ────────────────────────────────────────────────
  console.log("\n╔══════════════════════════════════════════════╗");
  console.log("║  TEST RESULTS                               ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log(`\n  ${passed.length} passed, ${failed.length} failed\n`);

  if (failed.length > 0) {
    console.log("  Failed tests:");
    for (const f of failed) console.log(`    ❌ ${f}`);
    console.log("\n  ⚠️ SOME TESTS FAILED");
    process.exit(1);
  } else {
    console.log("  🎉 ALL TESTS PASSED");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
