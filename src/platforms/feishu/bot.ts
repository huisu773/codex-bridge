import * as lark from "@larksuiteoapi/node-sdk";
import express from "express";
import { config } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { initFeishuClient, handleFeishuEvent } from "./handler.js";
import { getServiceMetrics, setPlatformStatus } from "../../utils/metrics.js";
import { getTotalRunningCount } from "../../engines/index.js";

let wsClient: lark.WSClient | null = null;
let server: ReturnType<typeof express.application.listen> | null = null;
let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;

export async function startFeishuBot(): Promise<void> {
  if (
    !config.feishu.appId ||
    config.feishu.appId === "your_feishu_app_id"
  ) {
    logger.warn("Feishu app not configured, skipping Feishu integration");
    return;
  }

  const client = initFeishuClient(config.feishu.appId, config.feishu.appSecret);

  await connectFeishuWS();

  // Still start Express for health check
  const app = express();
  app.get("/health", (_req, res) => {
    const metrics = getServiceMetrics(getTotalRunningCount());
    res.json({
      status: "ok",
      service: "codex-bridge",
      timestamp: new Date().toISOString(),
      ...metrics,
    });
  });

  return new Promise<void>((resolve) => {
    server = app.listen(config.webhook.port, config.webhook.host, () => {
      logger.info(
        { port: config.webhook.port, host: config.webhook.host },
        "Health check server started",
      );
      resolve();
    });
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        logger.warn({ port: config.webhook.port }, "Health check port in use — skipping (non-fatal)");
      } else {
        logger.error({ err }, "Health check server error");
      }
      resolve(); // Don't crash the whole service
    });
  });
}

async function connectFeishuWS(): Promise<void> {
  // Use WSClient (WebSocket long connection) — no public URL needed
  wsClient = new lark.WSClient({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    loggerLevel: lark.LoggerLevel.info,
  });

  const eventDispatcher = new lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data: any) => {
      logger.info(
        { senderId: data?.sender?.sender_id?.open_id, chatId: data?.message?.chat_id },
        "Feishu event received via WebSocket",
      );
      // Must return within 3 seconds — process asynchronously
      setImmediate(async () => {
        try {
          await handleFeishuEvent(data);
        } catch (err) {
          logger.error({ err }, "Error processing Feishu event");
        }
      });
    },
  });

  try {
    await wsClient.start({ eventDispatcher });
    reconnectAttempts = 0;
    setPlatformStatus("feishu", "connected");
    logger.info("Feishu WebSocket client started (long connection mode)");
  } catch (err) {
    logger.error({ err }, "Feishu WebSocket start failed");
    scheduleReconnect();
  }
}

const MAX_RECONNECT_ATTEMPTS = 50;

function scheduleReconnect(): void {
  if (reconnectTimeout) clearTimeout(reconnectTimeout);
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    setPlatformStatus("feishu", "disconnected");
    logger.error(
      { attempts: reconnectAttempts },
      "Feishu WS max reconnect attempts reached — giving up. Restart the service to retry.",
    );
    return;
  }
  const backoffMs = Math.min(1000 * Math.pow(2, reconnectAttempts), 60_000);
  reconnectAttempts++;
  logger.info({ backoffMs, attempt: reconnectAttempts }, "Scheduling Feishu WS reconnect");

  reconnectTimeout = setTimeout(async () => {
    try {
      if (wsClient) {
        try { wsClient.close(); } catch { /* ignore */ }
        wsClient = null;
      }
      await connectFeishuWS();
    } catch (err) {
      logger.error({ err }, "Feishu reconnect failed");
      scheduleReconnect();
    }
  }, backoffMs);
}

export function stopFeishuBot(): void {
  setPlatformStatus("feishu", "disconnected");
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  if (wsClient) {
    wsClient.close();
    logger.info("Feishu WebSocket client closed");
  }
  if (server) {
    server.close();
    logger.info("Health check server stopped");
  }
}
