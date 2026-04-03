/**
 * Test: Claude engine model whitelist and /engine claude switch.
 */

import { deleteSession, getSession } from "../src/core/session-manager.js";
import { getRegistry } from "../src/commands/registry.js";
import { registerSessionCommands } from "../src/commands/session-commands.js";
import { registerCustomCommands } from "../src/commands/custom.js";
import { setEngine, getEngine, getExecutor } from "../src/engines/index.js";
import { CLAUDE_MODELS } from "../src/engines/model-catalog.js";
import type { PlatformMessage } from "../src/platforms/types.js";

async function main() {
  const registry = getRegistry();
  registry.clear();
  registerSessionCommands();
  registerCustomCommands();

  const msg: PlatformMessage = {
    platform: "telegram",
    userId: "test-user",
    chatId: "test-claude",
    text: "/model",
  };
  const chatKey = `${msg.platform}:${msg.chatId}`;
  deleteSession(msg.platform, msg.chatId);

  // ── Test 1: Claude engine registration ──
  const executor = getExecutor("claude");
  if (!executor) throw new Error("claude engine not registered");
  if (executor.name !== "claude") throw new Error(`expected engine name 'claude', got '${executor.name}'`);
  console.log("✅ Test 1: Claude engine registered");

  // ── Test 2: Claude model catalog ──
  const models = executor.listModels();
  if (models.length === 0) throw new Error("no claude models defined");
  const defaultModel = models.find((m) => m.recommended);
  if (!defaultModel) throw new Error("no recommended claude model");
  if (defaultModel.id !== "qwen/qwen3.6-plus:free") {
    throw new Error(`expected default model 'qwen/qwen3.6-plus:free', got '${defaultModel.id}'`);
  }
  const minimaxModel = models.find((m) => m.id === "minimax/minimax-m2.7");
  if (!minimaxModel) throw new Error("minimax/minimax-m2.7 not in claude models");
  console.log("✅ Test 2: Claude model catalog correct");

  // ── Test 3: Engine switch via /engine claude ──
  const engineCmd = registry.get("engine");
  if (!engineCmd) throw new Error("engine command not registered");

  const replies: string[] = [];
  const sendReply = async (text: string) => { replies.push(text); };
  const sendFile = async () => {};

  await engineCmd.execute(msg, "claude", sendReply, sendFile);
  const currentEngine = getEngine(chatKey);
  if (currentEngine !== "claude") {
    throw new Error(`expected engine 'claude' after switch, got '${currentEngine}'`);
  }
  const lastReply = replies.at(-1) || "";
  if (!lastReply.includes("claude")) {
    throw new Error(`expected reply to mention 'claude', got: ${lastReply}`);
  }
  console.log("✅ Test 3: /engine claude switch works");

  // ── Test 4: Model whitelist enforcement for claude ──
  setEngine(chatKey, "claude");
  const modelCmd = registry.get("model");
  if (!modelCmd) throw new Error("model command not registered");

  replies.length = 0;
  await modelCmd.execute(msg, "qwen/qwen3.6-plus:free", sendReply, sendFile);
  const session = getSession(msg.platform, msg.chatId);
  if (!session || session.model !== "qwen/qwen3.6-plus:free") {
    throw new Error("allowed model was not applied for claude");
  }
  console.log("✅ Test 4: Allowed model accepted");

  replies.length = 0;
  await modelCmd.execute(msg, "invalid-model-name", sendReply, sendFile);
  const sessionAfter = getSession(msg.platform, msg.chatId);
  if (!sessionAfter || sessionAfter.model !== "qwen/qwen3.6-plus:free") {
    throw new Error("unsupported model should not change session model");
  }
  const blockReply = replies.at(-1) || "";
  if (!blockReply.includes("Unsupported model")) {
    throw new Error(`expected unsupported model reply, got: ${blockReply}`);
  }
  console.log("✅ Test 5: Invalid model rejected");

  // ── Test 6: /engine shows claude in list ──
  replies.length = 0;
  await engineCmd.execute(msg, "", sendReply, sendFile);
  const listReply = replies.at(-1) || "";
  if (!listReply.includes("claude")) {
    throw new Error(`/engine list should mention claude, got: ${listReply}`);
  }
  console.log("✅ Test 6: /engine list includes claude");

  // ── Test 7: CLAUDE_MODELS export integrity ──
  if (!Array.isArray(CLAUDE_MODELS)) throw new Error("CLAUDE_MODELS not an array");
  for (const m of CLAUDE_MODELS) {
    if (!m.id) throw new Error("model missing id");
  }
  console.log("✅ Test 7: CLAUDE_MODELS export valid");

  deleteSession(msg.platform, msg.chatId);
  console.log("\n✅ All Claude engine tests passed!");
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
