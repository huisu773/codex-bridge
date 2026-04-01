import { logger } from "../utils/logger.js";
import { getRegistry } from "../commands/registry.js";
import type { PlatformMessage } from "../platforms/types.js";

export interface ParsedCommand {
  command: string;
  args: string;
  raw: string;
}

export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;

  // Treat sequences like "---" as plain text, not commands
  if (/^\/[-]+/.test(trimmed)) return null;

  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1) {
    return { command: trimmed.slice(1).toLowerCase(), args: "", raw: trimmed };
  }
  return {
    command: trimmed.slice(1, spaceIdx).toLowerCase(),
    args: trimmed.slice(spaceIdx + 1).trim(),
    raw: trimmed,
  };
}

export type CommandHandler = (
  msg: PlatformMessage,
  args: string,
  sendReply: (text: string) => Promise<void>,
  sendFile: (path: string, caption?: string) => Promise<void>,
) => Promise<void>;

export async function routeMessage(
  msg: PlatformMessage,
  sendReply: (text: string) => Promise<void>,
  sendFile: (path: string, caption?: string) => Promise<void>,
): Promise<void> {
  const parsed = parseCommand(msg.text);

  if (parsed) {
    // Strip @botname suffix if present (e.g., /help@mybot)
    const cmdName = parsed.command.replace(/@.*$/, "");
    const registry = getRegistry();
    const handler = registry.get(cmdName);

    if (handler) {
      logger.info(
        { command: cmdName, platform: msg.platform, userId: msg.userId },
        "Routing command",
      );
      await handler.execute(msg, parsed.args, sendReply, sendFile);
    } else {
      await sendReply(
        `❌ Unknown command: /${cmdName}\nUse /help to see available commands.`,
      );
    }
  } else {
    // Non-command message → route to codex execution
    const registry = getRegistry();
    const codexHandler = registry.get("__codex_passthrough__");
    if (codexHandler) {
      await codexHandler.execute(msg, msg.text, sendReply, sendFile);
    } else {
      await sendReply("⚠️ Codex handler not initialized.");
    }
  }
}
