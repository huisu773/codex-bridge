import { deleteSession, getSession } from "../src/core/session-manager.js";
import { getRegistry } from "../src/commands/registry.js";
import { registerSessionCommands } from "../src/commands/session-commands.js";
import { setEngine } from "../src/engines/index.js";
import type { PlatformMessage } from "../src/platforms/types.js";

async function main() {
  const registry = getRegistry();
  registry.clear();
  registerSessionCommands();

  const command = registry.get("model");
  if (!command) {
    throw new Error("model command not registered");
  }

  const msg: PlatformMessage = {
    platform: "telegram",
    userId: "u1",
    chatId: "c1",
    text: "/model",
  };

  const chatKey = `${msg.platform}:${msg.chatId}`;
  setEngine(chatKey, "copilot");
  deleteSession(msg.platform, msg.chatId);

  const replies: string[] = [];
  const sendReply = async (text: string) => {
    replies.push(text);
  };
  const sendFile = async () => {};

  await command.execute(msg, "gpt-5-mini", sendReply, sendFile);
  const sessionAfterAllowed = getSession(msg.platform, msg.chatId);
  if (!sessionAfterAllowed || sessionAfterAllowed.model !== "gpt-5-mini") {
    throw new Error("allowed model was not applied");
  }

  await command.execute(msg, "not-in-docs", sendReply, sendFile);
  const sessionAfterBlocked = getSession(msg.platform, msg.chatId);
  if (!sessionAfterBlocked || sessionAfterBlocked.model !== "gpt-5-mini") {
    throw new Error("unsupported model should not overwrite session model");
  }

  const lastReply = replies.at(-1) || "";
  if (!lastReply.includes("Unsupported model")) {
    throw new Error(`expected unsupported-model reply, got: ${lastReply}`);
  }

  deleteSession(msg.platform, msg.chatId);
  console.log("OK: /model enforces documented model whitelist.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
