import pino from "pino";
import { config } from "../config.js";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

const logDir = dirname(config.log.file);
if (!existsSync(logDir)) {
  mkdirSync(logDir, { recursive: true });
}

const targets: pino.TransportTargetOptions[] = [
  {
    target: "pino/file",
    options: { destination: config.log.file, mkdir: true },
    level: config.log.level,
  },
  {
    target: "pino/file",
    options: { destination: 1 }, // stdout
    level: config.log.level,
  },
];

export const logger = pino({
  level: config.log.level,
  transport: { targets },
  timestamp: pino.stdTimeFunctions.isoTime,
});
