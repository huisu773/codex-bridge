import { Bot } from "grammy";
import { config } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { handleTelegramMessage } from "./handler.js";

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

  // Use long polling
  await bot.start({
    onStart: () => {
      logger.info("Telegram bot started (long polling)");
    },
  });
}

export function stopTelegramBot(): void {
  if (bot) {
    bot.stop();
    logger.info("Telegram bot stopped");
  }
}
