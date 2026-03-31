/**
 * Shared utilities for command handlers.
 */

import { existsSync, readFileSync } from "node:fs";
import { logger } from "../utils/logger.js";
import { config } from "../config.js";
import { execFileSync } from "node:child_process";

/** Build the prompt by injecting pending file context and separating images. */
export function buildPromptWithFiles(
  text: string,
  pendingFiles: string[],
): { prompt: string; imageFiles: string[] } {
  let prompt = text;
  const imageFiles: string[] = [];
  const otherFiles: string[] = [];

  for (const f of pendingFiles) {
    if (/\.(ogg|opus|mp3|wav|m4a|flac)$/i.test(f)) continue;
    if (/\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i.test(f)) {
      imageFiles.push(f);
    } else {
      otherFiles.push(f);
    }
  }

  if (otherFiles.length > 0) {
    const fileList = otherFiles.map((p) => `  - ${p}`).join("\n");
    prompt = `[Context: The user recently uploaded the following file(s) to the working directory:\n${fileList}\nPlease take these files into account when responding.]\n\n${prompt}`;
  }
  if (imageFiles.length > 0 && !prompt) {
    prompt = "Please describe or analyze the image(s) I just sent.";
  }

  return { prompt, imageFiles };
}

/** Classify an error into a user-friendly message with recovery hints. */
export function classifyError(err: unknown): string {
  if (!(err instanceof Error)) return `❌ Execution error: ${String(err)}`;
  const m = err.message;
  if (m.includes("ENOENT") || m.includes("spawn")) {
    return "❌ Codex CLI not found. Check CODEX_BIN path in configuration.";
  }
  if (m.includes("ETIMEDOUT") || m.includes("timeout") || m.includes("AbortError")) {
    return "⏱️ Request timed out. Try a simpler instruction or use /cancel.";
  }
  if (m.includes("ENOMEM") || m.includes("memory")) {
    return "❌ Out of memory. Try a smaller task or restart the service.";
  }
  return `❌ Execution error: ${m}`;
}

// Per-chat task queue for serial execution within a chat, parallel across chats
const chatQueues = new Map<string, Promise<void>>();

export function enqueueChatTask(chatKey: string, task: () => Promise<void>): Promise<void> {
  const previous = chatQueues.get(chatKey) || Promise.resolve();
  const current = previous.then(task).catch((err) => {
    logger.error({ err, chatKey }, "Chat task queue error");
  });
  chatQueues.set(chatKey, current);
  return current;
}

/** Parse Codex auth.json for account info (plan, subscription, token status). */
export function getCodexAccountInfo(): Record<string, string> {
  const info: Record<string, string> = {};
  try {
    const authPath = process.env.HOME
      ? `${process.env.HOME}/.codex/auth.json`
      : "/root/.codex/auth.json";
    if (!existsSync(authPath)) return info;

    const auth = JSON.parse(readFileSync(authPath, "utf-8"));
    info.authMode = auth.auth_mode || "unknown";

    const tokens = auth.tokens;
    if (tokens?.access_token) {
      const parts = tokens.access_token.split(".");
      if (parts.length >= 2) {
        const payload = JSON.parse(
          Buffer.from(parts[1], "base64url").toString("utf-8"),
        );
        const chatgptAuth = payload["https://api.openai.com/auth"] || {};
        info.plan = chatgptAuth.chatgpt_plan_type || "unknown";
        info.userId = chatgptAuth.chatgpt_user_id || "";

        const profile = payload["https://api.openai.com/profile"] || {};
        info.email = profile.email || "";

        if (payload.exp) {
          const expDate = new Date(payload.exp * 1000);
          const now = new Date();
          const hoursLeft = Math.round(
            (expDate.getTime() - now.getTime()) / 3600_000,
          );
          info.tokenExpiry = expDate.toISOString();
          info.tokenStatus =
            hoursLeft > 0 ? `✅ Valid (${hoursLeft}h left)` : "❌ Expired";
        }
      }
    }

    if (tokens?.id_token) {
      const parts = tokens.id_token.split(".");
      if (parts.length >= 2) {
        const payload = JSON.parse(
          Buffer.from(parts[1], "base64url").toString("utf-8"),
        );
        const chatgptAuth = payload["https://api.openai.com/auth"] || {};
        if (chatgptAuth.chatgpt_subscription_active_until) {
          const until = new Date(chatgptAuth.chatgpt_subscription_active_until);
          const now = new Date();
          const daysLeft = Math.round(
            (until.getTime() - now.getTime()) / 86400_000,
          );
          info.subscriptionUntil = until.toISOString().split("T")[0];
          info.subscriptionStatus =
            daysLeft > 0 ? `✅ Active (${daysLeft}d left)` : "❌ Expired";
        }
      }
    }

    if (auth.last_refresh) {
      info.lastRefresh = auth.last_refresh;
    }
  } catch {
    // Ignore parse errors
  }
  return info;
}

/** Parse local settings to derive Copilot account/runtime info (best effort). */
export function getCopilotAccountInfo(): Record<string, string> {
  const info: Record<string, string> = {};
  try {
    info.bin = config.copilot.bin;
    info.binStatus = existsSync(config.copilot.bin) ? "✅ Found" : "❌ Not found";

    if (process.env.COPILOT_GITHUB_TOKEN) info.authSource = "COPILOT_GITHUB_TOKEN";
    else if (process.env.GH_TOKEN) info.authSource = "GH_TOKEN";
    else if (process.env.GITHUB_TOKEN) info.authSource = "GITHUB_TOKEN";
    else info.authSource = "local credential store / config";

    const ghHostsPath = process.env.HOME
      ? `${process.env.HOME}/.config/gh/hosts.yml`
      : "/root/.config/gh/hosts.yml";
    if (existsSync(ghHostsPath)) {
      const text = readFileSync(ghHostsPath, "utf-8");
      const userMatch = text.match(/^\s*user:\s*([^\s]+)\s*$/m);
      const hostMatch = text.match(/^([^\s:]+):\s*$/m);
      if (userMatch?.[1]) info.user = userMatch[1];
      if (hostMatch?.[1]) info.host = hostMatch[1];
      if (text.includes("oauth_token:")) info.tokenStatus = "✅ Present";
    }

    try {
      const version = execFileSync(config.copilot.bin, ["--version"], {
        encoding: "utf-8",
        timeout: 2000,
      }).trim();
      if (version) info.version = version;
    } catch {
      // Ignore version probe failures
    }
  } catch {
    // Ignore parse errors
  }
  return info;
}
