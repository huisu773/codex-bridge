/**
 * Test: Claude engine — comprehensive verification of all functions.
 */

import { deleteSession, getSession, getOrCreateSession } from "../src/core/session-manager.js";
import { getRegistry } from "../src/commands/registry.js";
import { registerSessionCommands } from "../src/commands/session-commands.js";
import { registerCustomCommands } from "../src/commands/custom.js";
import { setEngine, getEngine, getExecutor, getEngineLabel, cancelAllEngines, getTotalRunningCount } from "../src/engines/index.js";
import { CLAUDE_MODELS } from "../src/engines/model-catalog.js";
import { buildPromptWithImageRefs } from "../src/engines/claude.js";
import { getClaudeAccountInfo } from "../src/commands/utils.js";
import type { PlatformMessage } from "../src/platforms/types.js";

let passed = 0;
let failed = 0;

function ok(name: string) {
  passed++;
  console.log(`✅ ${name}`);
}

function fail(name: string, err: unknown) {
  failed++;
  console.error(`❌ ${name}:`, err instanceof Error ? err.message : err);
}

async function main() {
  const registry = getRegistry();
  registry.clear();
  registerSessionCommands();
  registerCustomCommands();

  const msg: PlatformMessage = {
    platform: "telegram",
    userId: "test-user",
    chatId: "test-claude-full",
    text: "/model",
  };
  const chatKey = `${msg.platform}:${msg.chatId}`;
  deleteSession(msg.platform, msg.chatId);

  const replies: string[] = [];
  const sendReply = async (text: string) => { replies.push(text); };
  const sendFile = async () => {};

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. Engine registry
  // ═══════════════════════════════════════════════════════════════════════════

  try {
    const executor = getExecutor("claude");
    if (!executor) throw new Error("not registered");
    if (executor.name !== "claude") throw new Error(`name=${executor.name}`);
    ok("1.1 Claude engine registered");
  } catch (e) { fail("1.1 Claude engine registered", e); }

  try {
    if (typeof getExecutor("claude").cancelAll !== "function") throw new Error("cancelAll not a function");
    if (typeof getExecutor("claude").getRunningCount !== "function") throw new Error("getRunningCount not a function");
    if (typeof getExecutor("claude").listModels !== "function") throw new Error("listModels not a function");
    if (typeof getExecutor("claude").execute !== "function") throw new Error("execute not a function");
    ok("1.2 Claude executor implements all EngineExecutor methods");
  } catch (e) { fail("1.2 Claude executor methods", e); }

  try {
    const result = cancelAllEngines();
    if (!("claude" in result)) throw new Error("cancelAllEngines missing claude key");
    if (typeof result.claude !== "number") throw new Error("claude cancel count not a number");
    ok("1.3 cancelAllEngines includes claude");
  } catch (e) { fail("1.3 cancelAllEngines", e); }

  try {
    const count = getTotalRunningCount();
    if (typeof count !== "number") throw new Error("not a number");
    ok("1.4 getTotalRunningCount includes claude");
  } catch (e) { fail("1.4 getTotalRunningCount", e); }

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. Model catalog
  // ═══════════════════════════════════════════════════════════════════════════

  try {
    const models = getExecutor("claude").listModels();
    if (models.length === 0) throw new Error("empty");
    const defaultModel = models.find((m) => m.recommended);
    if (!defaultModel || defaultModel.id !== "qwen/qwen3.6-plus:free") {
      throw new Error(`default=${defaultModel?.id}`);
    }
    ok("2.1 Default model is qwen/qwen3.6-plus:free");
  } catch (e) { fail("2.1 Default model", e); }

  try {
    const models = getExecutor("claude").listModels();
    const minimax = models.find((m) => m.id === "minimax/minimax-m2.7");
    if (!minimax) throw new Error("minimax/minimax-m2.7 not found");
    ok("2.2 minimax/minimax-m2.7 in catalog");
  } catch (e) { fail("2.2 minimax model", e); }

  try {
    for (const m of CLAUDE_MODELS) {
      if (!m.id) throw new Error("model missing id");
      if (typeof m.id !== "string") throw new Error("model id not string");
    }
    ok("2.3 All CLAUDE_MODELS have valid id");
  } catch (e) { fail("2.3 CLAUDE_MODELS integrity", e); }

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. /engine command
  // ═══════════════════════════════════════════════════════════════════════════

  try {
    const engineCmd = registry.get("engine")!;
    replies.length = 0;
    await engineCmd.execute(msg, "claude", sendReply, sendFile);
    if (getEngine(chatKey) !== "claude") throw new Error(`engine=${getEngine(chatKey)}`);
    ok("3.1 /engine claude switches engine");
  } catch (e) { fail("3.1 /engine claude switch", e); }

  try {
    if (getEngineLabel(chatKey) !== "claude") throw new Error(`label=${getEngineLabel(chatKey)}`);
    ok("3.2 getEngineLabel returns 'claude'");
  } catch (e) { fail("3.2 getEngineLabel", e); }

  try {
    const engineCmd = registry.get("engine")!;
    replies.length = 0;
    await engineCmd.execute(msg, "", sendReply, sendFile);
    const listReply = replies.at(-1) || "";
    if (!listReply.includes("claude")) throw new Error("missing claude in list");
    if (!listReply.includes("copilot")) throw new Error("missing copilot in list");
    if (!listReply.includes("codex")) throw new Error("missing codex in list");
    // Copilot should say multi-turn, not single request
    if (listReply.includes("single request")) throw new Error("copilot should not say 'single request'");
    ok("3.3 /engine list shows all 3 engines with correct descriptions");
  } catch (e) { fail("3.3 /engine list", e); }

  try {
    const engineCmd = registry.get("engine")!;
    replies.length = 0;
    await engineCmd.execute(msg, "invalid", sendReply, sendFile);
    const reply = replies.at(-1) || "";
    if (!reply.includes("Invalid engine")) throw new Error(`reply=${reply}`);
    ok("3.4 /engine rejects invalid engine name");
  } catch (e) { fail("3.4 /engine invalid", e); }

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. /model command with claude
  // ═══════════════════════════════════════════════════════════════════════════

  try {
    setEngine(chatKey, "claude");
    const modelCmd = registry.get("model")!;
    replies.length = 0;
    await modelCmd.execute(msg, "qwen/qwen3.6-plus:free", sendReply, sendFile);
    const session = getSession(msg.platform, msg.chatId);
    if (session?.model !== "qwen/qwen3.6-plus:free") throw new Error(`model=${session?.model}`);
    ok("4.1 /model accepts valid claude model");
  } catch (e) { fail("4.1 /model valid", e); }

  try {
    const modelCmd = registry.get("model")!;
    replies.length = 0;
    await modelCmd.execute(msg, "minimax/minimax-m2.7", sendReply, sendFile);
    const session = getSession(msg.platform, msg.chatId);
    if (session?.model !== "minimax/minimax-m2.7") throw new Error(`model=${session?.model}`);
    ok("4.2 /model accepts minimax/minimax-m2.7");
  } catch (e) { fail("4.2 /model minimax", e); }

  try {
    const modelCmd = registry.get("model")!;
    replies.length = 0;
    await modelCmd.execute(msg, "gpt-5.4-mini", sendReply, sendFile);
    const session = getSession(msg.platform, msg.chatId);
    if (session?.model === "gpt-5.4-mini") throw new Error("should not accept codex model on claude");
    const reply = replies.at(-1) || "";
    if (!reply.includes("Unsupported")) throw new Error(`reply=${reply}`);
    ok("4.3 /model rejects codex model on claude engine");
  } catch (e) { fail("4.3 /model cross-engine rejection", e); }

  try {
    const modelCmd = registry.get("model")!;
    replies.length = 0;
    await modelCmd.execute(msg, "", sendReply, sendFile);
    const reply = replies.at(-1) || "";
    if (!reply.includes("qwen/qwen3.6-plus:free")) throw new Error("missing default model in listing");
    if (!reply.includes("minimax/minimax-m2.7")) throw new Error("missing minimax in listing");
    ok("4.4 /model (no args) lists claude models");
  } catch (e) { fail("4.4 /model listing", e); }

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. /status command — claude info
  // ═══════════════════════════════════════════════════════════════════════════

  try {
    const statusCmd = registry.get("status")!;
    replies.length = 0;
    await statusCmd.execute(msg, "", sendReply, sendFile);
    const reply = replies.at(-1) || "";
    if (!reply.includes("Claude")) throw new Error("missing Claude in status");
    // Should have 2 Claude lines in Account section
    if (!reply.includes("Claude CLI:")) throw new Error("missing 'Claude CLI:' line");
    ok("5.1 /status shows Claude account info");
  } catch (e) { fail("5.1 /status Claude", e); }

  try {
    const statusCmd = registry.get("status")!;
    replies.length = 0;
    setEngine(chatKey, "claude");
    await statusCmd.execute(msg, "", sendReply, sendFile);
    const reply = replies.at(-1) || "";
    if (!reply.includes("Claude session:")) throw new Error("missing claude session info");
    ok("5.2 /status shows Claude session when claude engine active");
  } catch (e) { fail("5.2 /status session", e); }

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. /config command — claude binary
  // ═══════════════════════════════════════════════════════════════════════════

  try {
    const configCmd = registry.get("config")!;
    replies.length = 0;
    await configCmd.execute(msg, "", sendReply, sendFile);
    const reply = replies.at(-1) || "";
    if (!reply.includes("Claude binary:")) throw new Error("missing Claude binary line");
    if (!reply.includes("Codex binary:")) throw new Error("missing Codex binary line");
    if (!reply.includes("Copilot binary:")) throw new Error("missing Copilot binary line");
    ok("6.1 /config shows all 3 engine binaries");
  } catch (e) { fail("6.1 /config binaries", e); }

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. /compact, /cancel, /sessions — claude support
  // ═══════════════════════════════════════════════════════════════════════════

  try {
    const cancelCmd = registry.get("cancel")!;
    replies.length = 0;
    await cancelCmd.execute(msg, "", sendReply, sendFile);
    const reply = replies.at(-1) || "";
    // Should not error — 0 tasks is fine
    if (!reply.includes("No running tasks") && !reply.includes("Cancelled")) {
      throw new Error(`unexpected reply: ${reply}`);
    }
    ok("7.1 /cancel works with claude engine");
  } catch (e) { fail("7.1 /cancel", e); }

  try {
    const sessionsCmd = registry.get("sessions")!;
    replies.length = 0;
    await sessionsCmd.execute(msg, "", sendReply, sendFile);
    const reply = replies.at(-1) || "";
    // Should contain 'claude:' in session detail (session listing includes claude session ID)
    if (!reply.includes("claude:")) throw new Error("sessions list missing claude session field");
    ok("7.2 /sessions shows claude session IDs");
  } catch (e) { fail("7.2 /sessions", e); }

  // ═══════════════════════════════════════════════════════════════════════════
  // 8. buildPromptWithImageRefs
  // ═══════════════════════════════════════════════════════════════════════════

  try {
    const result = buildPromptWithImageRefs("hello", undefined, "/work");
    if (result !== "hello") throw new Error(`expected 'hello', got '${result}'`);
    ok("8.1 buildPromptWithImageRefs — no images");
  } catch (e) { fail("8.1 no images", e); }

  try {
    const result = buildPromptWithImageRefs("analyze", ["/work/img.png"], "/work");
    if (!result.includes("@img.png")) throw new Error(`expected @img.png, got: ${result}`);
    if (!result.includes("analyze")) throw new Error("missing original prompt");
    ok("8.2 buildPromptWithImageRefs — relative path");
  } catch (e) { fail("8.2 image refs", e); }

  try {
    const result = buildPromptWithImageRefs("look", ["/other/img.png"], "/work");
    if (!result.includes("@/other/img.png")) throw new Error(`expected absolute path, got: ${result}`);
    ok("8.3 buildPromptWithImageRefs — absolute path (outside workdir)");
  } catch (e) { fail("8.3 image absolute", e); }

  // ═══════════════════════════════════════════════════════════════════════════
  // 9. getClaudeAccountInfo
  // ═══════════════════════════════════════════════════════════════════════════

  try {
    const info = getClaudeAccountInfo();
    if (!info.model) throw new Error("missing model");
    if (!info.status) throw new Error("missing status");
    if (info.status !== "✅ Available" && info.status !== "❌ CLI not found") {
      throw new Error(`unexpected status: ${info.status}`);
    }
    ok("9.1 getClaudeAccountInfo returns model and status");
  } catch (e) { fail("9.1 getClaudeAccountInfo", e); }

  // ═══════════════════════════════════════════════════════════════════════════
  // 10. Engine switch round-trip: model resets correctly
  // ═══════════════════════════════════════════════════════════════════════════

  try {
    const engineCmd = registry.get("engine")!;
    replies.length = 0;
    await engineCmd.execute(msg, "codex", sendReply, sendFile);
    const session1 = getSession(msg.platform, msg.chatId);
    const codexModel = session1?.model;

    replies.length = 0;
    await engineCmd.execute(msg, "claude", sendReply, sendFile);
    const session2 = getSession(msg.platform, msg.chatId);
    const claudeModel = session2?.model;

    if (codexModel === claudeModel) throw new Error("model should change on engine switch");
    ok("10.1 Engine switch resets model to engine default");
  } catch (e) { fail("10.1 engine switch model reset", e); }

  // ═══════════════════════════════════════════════════════════════════════════
  // Cleanup & summary
  // ═══════════════════════════════════════════════════════════════════════════

  deleteSession(msg.platform, msg.chatId);

  console.log(`\n${"═".repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed (${passed + failed} total)`);
  console.log(`${"═".repeat(50)}`);

  if (failed > 0) {
    console.error("\n❌ Some tests failed!");
    process.exit(1);
  }
  console.log("\n✅ All Claude engine tests passed!");
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Test crashed:", err);
  process.exit(1);
});
