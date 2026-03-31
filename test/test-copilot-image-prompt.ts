/**
 * Unit test for Copilot image prompt references.
 *
 * Run: npx tsx test/test-copilot-image-prompt.ts
 */

process.env.TELEGRAM_BOT_TOKEN = "test:fake";
process.env.FEISHU_APP_ID = "test";
process.env.FEISHU_APP_SECRET = "test";

import { buildPromptWithImageRefs } from "../src/engines/copilot.js";

function assert(label: string, condition: boolean) {
  if (!condition) {
    throw new Error(`Assertion failed: ${label}`);
  }
  console.log(`✅ ${label}`);
}

const workDir = "/root/codex-workspace/codex-bridge";
const prompt = "Please analyze the attached design.";
const images = [
  "/root/codex-workspace/codex-bridge/mockups/home.png",
  "/tmp/figure.jpg",
];

const out = buildPromptWithImageRefs(prompt, images, workDir);

assert("keeps original prompt", out.includes(prompt));
assert("injects local relative image reference", out.includes("@mockups/home.png"));
assert("injects external absolute image reference", out.includes("@/tmp/figure.jpg"));
assert("contains image context instruction", out.includes("Please use these images as visual context."));

console.log("\nAll assertions passed.");
