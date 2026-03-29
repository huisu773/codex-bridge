import { Bot } from "grammy";
import { config } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { handleTelegramMessage } from "./handler.js";
import { getUniqueCommands } from "../../commands/registry.js";
import { setPlatformStatus } from "../../utils/metrics.js";

let bot: Bot | null = null;

export async function startTelegramBot(): Promise<void> {
  if (!config.telegram.botToken || config.telegram.botToken === "your_telegram_bot_token_here") {
    logger.warn("Telegram bot token not configured, skipping Telegram integration");
    return;
  }

  bot = new Bot(config.telegram.botToken);

  bot.on("message:text", handleTelegramMessage);
  bot.on("message:document", handleTelegramMessage);
  bot.on("message:photo", handleTelegramMessage);
  bot.on("message:voice", handleTelegramMessage);
  bot.on("message:audio", handleTelegramMessage);
  bot.on("message:video_note", handleTelegramMessage);

  bot.catch((err) => {
    logger.error({ err: err.error }, "Telegram bot error");
  });

  // Sync slash commands with Telegram's autocomplete menu
  try {
    const cmds = getUniqueCommands().map((c) => ({
      command: c.name,
      description: c.description,
    }));
    await bot.api.setMyCommands(cmds);
    logger.info({ count: cmds.length }, "Telegram slash commands synced");
  } catch (err) {
    logger.warn({ err }, "Failed to sync Telegram slash commands");
  }

  // Use long polling
  await bot.start({
    onStart: () => {
      setPlatformStatus("telegram", "connected");
      logger.info("Telegram bot started (long polling)");
    },
  });
}

export function stopTelegramBot(): void {
  if (bot) {
    bot.stop();
    setPlatformStatus("telegram", "disconnected");
    logger.info("Telegram bot stopped");
  }
}
