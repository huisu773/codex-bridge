import { config } from "./config.js";
import { logger } from "./utils/logger.js";
import { loadSessionsFromDisk, cleanExpiredSessions } from "./core/session-manager.js";
import { cancelAllTasks } from "./core/codex-executor.js";
import { cancelAllCopilotTasks, cancelAllPendingAskUser } from "./copilot/index.js";
import { registerNativeCommands } from "./commands/native.js";
import { registerCustomCommands } from "./commands/custom.js";
import { registerHelpCommand } from "./commands/help.js";
import { startTelegramBot, stopTelegramBot } from "./platforms/telegram/bot.js";
import { startFeishuBot, stopFeishuBot } from "./platforms/feishu/bot.js";

/** Wrap a promise with a timeout */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} startup timed out after ${ms}ms`)), ms),
    ),
  ]);
}

const PLATFORM_STARTUP_TIMEOUT = 15_000;
const SHUTDOWN_GRACE_MS = 10_000;

async function main() {
  logger.info("=== Codex Bridge starting ===");
  logger.info({
    codexBin: config.codex.bin,
    model: config.codex.model,
    workingDir: config.codex.workingDir,
    webhookPort: config.webhook.port,
    engine: config.engine,
    copilotBin: config.copilot.bin,
    copilotModel: config.copilot.model,
  }, "Configuration loaded");

  // Load existing sessions
  loadSessionsFromDisk();

  // Register all commands
  registerNativeCommands();
  registerCustomCommands();
  registerHelpCommand();
  logger.info("Commands registered");

  // Start platforms independently with timeout — one failure doesn't block the other
  const results = await Promise.allSettled([
    withTimeout(startTelegramBot(), PLATFORM_STARTUP_TIMEOUT, "Telegram"),
    withTimeout(startFeishuBot(), PLATFORM_STARTUP_TIMEOUT, "Feishu"),
  ]);
  for (const r of results) {
    if (r.status === "rejected") {
      logger.error({ err: r.reason }, "Platform startup failed (non-fatal, other platforms may still work)");
    }
  }

  // Periodic session cleanup (every hour)
  setInterval(() => {
    cleanExpiredSessions();
  }, 3600_000);

  logger.info("=== Codex Bridge is running ===");
}

// Graceful shutdown with timeout
let isShuttingDown = false;
function shutdown(signal: string) {
  if (isShuttingDown) return; // Prevent multiple invocations
  isShuttingDown = true;
  logger.info({ signal }, "Shutting down...");

  // Force exit if graceful shutdown takes too long
  const forceTimer = setTimeout(() => {
    logger.warn("Graceful shutdown timed out, forcing exit");
    process.exit(1);
  }, SHUTDOWN_GRACE_MS);
  forceTimer.unref();

  try {
    const cancelled = cancelAllTasks();
    const copilotCancelled = cancelAllCopilotTasks();
    cancelAllPendingAskUser();
    if (cancelled + copilotCancelled > 0) logger.info({ cancelled, copilotCancelled }, "Cancelled running tasks");
    stopTelegramBot();
    stopFeishuBot();
  } catch (err) {
    logger.error({ err }, "Error during shutdown cleanup");
  }

  // Brief grace period to let in-flight stream cards finalize
  setTimeout(() => {
    process.exit(0);
  }, 2000).unref();
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
