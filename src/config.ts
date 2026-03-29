import dotenv from "dotenv";

// Load .env with override=true so project .env always takes priority
// over system environment variables (prevents token confusion with other bots)
dotenv.config({ override: true });

export interface Config {
  telegram: {
    botToken: string;
    allowedUserIds: number[];
  };
  feishu: {
    appId: string;
    appSecret: string;
    verificationToken: string;
    encryptKey: string;
    allowedUserIds: string[];
  };
  webhook: {
    port: number;
    host: string;
  };
  codex: {
    model: string;
    workingDir: string;
    bin: string;
    timeoutMs: number;
    maxTimeoutMs: number;
  };
  session: {
    dir: string;
    maxAgeHours: number;
  };
  security: {
    rateLimitPerMinute: number;
  };
  stt: {
    provider: string;
    apiKey: string;
    model: string;
    endpoint: string;
    localBin: string;
    language: string;
  };
  limits: {
    fiveHourMaxRequests: number;
    weeklyMaxRequests: number;
  };
  log: {
    level: string;
    file: string;
  };
}

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optional(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

/** Expand ~ to $HOME in paths */
function resolvePath(p: string): string {
  const HOME = process.env.HOME || "/root";
  if (p.startsWith("~/")) return HOME + p.slice(1);
  if (p === "~") return HOME;
  return p;
}

function parseIds(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseNumericIds(raw: string): number[] {
  return parseIds(raw).map(Number).filter((n) => !isNaN(n));
}

export function loadConfig(): Config {
  const HOME = process.env.HOME || "/root";
  return {
    telegram: {
      botToken: required("TELEGRAM_BOT_TOKEN"),
      allowedUserIds: parseNumericIds(optional("ALLOWED_TELEGRAM_IDS", "")),
    },
    feishu: {
      appId: required("FEISHU_APP_ID"),
      appSecret: required("FEISHU_APP_SECRET"),
      verificationToken: optional("FEISHU_VERIFICATION_TOKEN", ""),
      encryptKey: optional("FEISHU_ENCRYPT_KEY", ""),
      allowedUserIds: parseIds(optional("ALLOWED_FEISHU_IDS", "")),
    },
    webhook: {
      port: Number(optional("WEBHOOK_PORT", "9800")),
      host: optional("WEBHOOK_HOST", "127.0.0.1"),
    },
    codex: {
      model: optional("CODEX_MODEL", "gpt-5.3-codex"),
      workingDir: resolvePath(optional("CODEX_WORKING_DIR", `${HOME}/codex-workspace`)),
      bin: optional("CODEX_BIN", "/usr/bin/codex"),
      timeoutMs: Number(optional("CODEX_TIMEOUT_MS", "300000")),
      maxTimeoutMs: Number(optional("CODEX_MAX_TIMEOUT_MS", "1800000")),
    },
    session: {
      dir: resolvePath(optional("SESSION_DIR", `${HOME}/codex-workspace/sessions`)),
      maxAgeHours: Number(optional("SESSION_MAX_AGE_HOURS", "168")),
    },
    security: {
      rateLimitPerMinute: Number(optional("RATE_LIMIT_PER_MINUTE", "30")),
    },
    stt: {
      provider: optional("STT_PROVIDER", "none"),
      apiKey: optional("STT_API_KEY", ""),
      model: optional("STT_MODEL", ""),
      endpoint: optional("STT_ENDPOINT", ""),
      localBin: optional("STT_LOCAL_BIN", "whisper"),
      language: optional("STT_LANGUAGE", ""),
    },
    limits: {
      fiveHourMaxRequests: Number(optional("FIVE_HOUR_MAX_REQUESTS", "50")),
      weeklyMaxRequests: Number(optional("WEEKLY_MAX_REQUESTS", "1000")),
    },
    log: {
      level: optional("LOG_LEVEL", "info"),
      file: resolvePath(optional("LOG_FILE", "./logs/codex-bridge.log")),
    },
  };
}

export const config = loadConfig();
