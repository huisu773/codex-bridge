import "dotenv/config";

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
      workingDir: optional("CODEX_WORKING_DIR", "/root/codex-workspace"),
      bin: optional("CODEX_BIN", "/usr/bin/codex"),
    },
    session: {
      dir: optional("SESSION_DIR", "/root/codex-workspace/sessions"),
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
      file: optional("LOG_FILE", "./logs/codex-bridge.log"),
    },
  };
}

export const config = loadConfig();
