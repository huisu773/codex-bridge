import * as lark from "@larksuiteoapi/node-sdk";
import express from "express";
import { config } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { initFeishuClient, handleFeishuEvent } from "./handler.js";

let wsClient: lark.WSClient | null = null;
let server: ReturnType<typeof express.application.listen> | null = null;

export async function startFeishuBot(): Promise<void> {
  if (
    !config.feishu.appId ||
    config.feishu.appId === "your_feishu_app_id"
  ) {
    logger.warn("Feishu app not configured, skipping Feishu integration");
    return;
  }

  const client = initFeishuClient(config.feishu.appId, config.feishu.appSecret);

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

  await wsClient.start({ eventDispatcher });
  logger.info("Feishu WebSocket client started (long connection mode)");

  // Still start Express for health check
  const app = express();
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      service: "codex-bridge",
      timestamp: new Date().toISOString(),
      feishu: wsClient ? "connected" : "disconnected",
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

export function stopFeishuBot(): void {
  if (wsClient) {
    wsClient.close();
    logger.info("Feishu WebSocket client closed");
  }
  if (server) {
    server.close();
    logger.info("Health check server stopped");
  }
}
