import { config } from "./config.js";
import { logger } from "./utils/logger.js";
import { loadSessionsFromDisk, cleanExpiredSessions } from "./core/session-manager.js";
import { registerNativeCommands } from "./commands/native.js";
import { registerCustomCommands } from "./commands/custom.js";
import { registerHelpCommand } from "./commands/help.js";
import { startTelegramBot, stopTelegramBot } from "./platforms/telegram/bot.js";
import { startFeishuBot, stopFeishuBot } from "./platforms/feishu/bot.js";

async function main() {
  logger.info("=== Codex Bridge starting ===");
  logger.info({
    codexBin: config.codex.bin,
    model: config.codex.model,
    workingDir: config.codex.workingDir,
    webhookPort: config.webhook.port,
  }, "Configuration loaded");

  // Load existing sessions
  loadSessionsFromDisk();

  // Register all commands
  registerNativeCommands();
  registerCustomCommands();
  registerHelpCommand();
  logger.info("Commands registered");

  // Start platforms
  const startups: Promise<void>[] = [];
  startups.push(
    startTelegramBot().catch((err) => {
      logger.error({ err }, "Failed to start Telegram bot");
    }),
  );
  startups.push(
    startFeishuBot().catch((err) => {
      logger.error({ err }, "Failed to start Feishu bot");
    }),
  );

  await Promise.all(startups);

  // Periodic session cleanup (every hour)
  setInterval(() => {
    cleanExpiredSessions();
  }, 3600_000);

  logger.info("=== Codex Bridge is running ===");
}

// Graceful shutdown
function shutdown(signal: string) {
  logger.info({ signal }, "Shutting down...");
  stopTelegramBot();
  stopFeishuBot();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "Uncaught exception");
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  logger.error({ err }, "Unhandled rejection");
});

main().catch((err) => {
  logger.fatal({ err }, "Fatal startup error");
  process.exit(1);
});
