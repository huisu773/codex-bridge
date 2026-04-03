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
  };
  copilot: {
    bin: string;
    model: string;
    configDir: string;
    timeoutMs: number;
    autopilot: boolean;
    allowAll: boolean;
    instructions: string;
    staleProcessMs: number;
  };
  claude: {
    bin: string;
    model: string;
    timeoutMs: number;
    staleProcessMs: number;
  };
  engine: "codex" | "copilot" | "claude";
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

function validatePort(val: number, key: string): number {
  if (isNaN(val) || val < 1 || val > 65535) {
    throw new Error(`Invalid port for ${key}: ${val} (must be 1-65535)`);
  }
  return val;
}

function validatePositiveInt(val: number, key: string): number {
  if (isNaN(val) || val < 0) {
    throw new Error(`Invalid value for ${key}: ${val} (must be non-negative integer)`);
  }
  return Math.floor(val);
}

function validateTimeout(val: number, key: string): number {
  if (isNaN(val) || val < 1000 || val > 7_200_000) {
    throw new Error(`Invalid timeout for ${key}: ${val}ms (must be 1s-2h)`);
  }
  return val;
}

export function loadConfig(): Config {
  const HOME = process.env.HOME || "/root";
    const engineVal = optional("DEFAULT_ENGINE", "codex");
    if (engineVal !== "codex" && engineVal !== "copilot" && engineVal !== "claude") {
      throw new Error(`Invalid DEFAULT_ENGINE: ${engineVal} (must be "codex", "copilot", or "claude")`);
    }
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
      port: validatePort(Number(optional("WEBHOOK_PORT", "9800")), "WEBHOOK_PORT"),
      host: optional("WEBHOOK_HOST", "127.0.0.1"),
    },
    codex: {
      model: optional("CODEX_MODEL", "gpt-5.4-mini"),
      workingDir: resolvePath(optional("CODEX_WORKING_DIR", `${HOME}/codex-workspace`)),
      bin: optional("CODEX_BIN", "/usr/bin/codex"),
      timeoutMs: validateTimeout(Number(optional("CODEX_TIMEOUT_MS", "600000")), "CODEX_TIMEOUT_MS"),
    },
    copilot: {
      bin: optional("COPILOT_BIN", "/usr/local/bin/copilot"),
      model: optional("COPILOT_MODEL", "gpt-5-mini"),
      configDir: resolvePath(optional("COPILOT_CONFIG_DIR", `${HOME}/.copilot-bridge`)),
      timeoutMs: validateTimeout(Number(optional("COPILOT_TIMEOUT_MS", "600000")), "COPILOT_TIMEOUT_MS"),
      autopilot: optional("COPILOT_AUTOPILOT", "true") === "true",
      allowAll: optional("COPILOT_ALLOW_ALL", "true") === "true",
      instructions: optional("COPILOT_INSTRUCTIONS", ""),
      staleProcessMs: validatePositiveInt(Number(optional("COPILOT_STALE_PROCESS_MS", "3600000")), "COPILOT_STALE_PROCESS_MS"),
    },
    claude: {
      bin: optional("CLAUDE_BIN", "/root/.npm-global/bin/claude"),
      model: optional("CLAUDE_MODEL", "qwen/qwen3.6-plus:free"),
      timeoutMs: validateTimeout(Number(optional("CLAUDE_TIMEOUT_MS", "600000")), "CLAUDE_TIMEOUT_MS"),
      staleProcessMs: validatePositiveInt(Number(optional("CLAUDE_STALE_PROCESS_MS", "3600000")), "CLAUDE_STALE_PROCESS_MS"),
    },
    engine: engineVal as "codex" | "copilot" | "claude",
    session: {
      dir: resolvePath(optional("SESSION_DIR", `${HOME}/codex-workspace/sessions`)),
      maxAgeHours: validatePositiveInt(Number(optional("SESSION_MAX_AGE_HOURS", "168")), "SESSION_MAX_AGE_HOURS"),
    },
    security: {
      rateLimitPerMinute: validatePositiveInt(Number(optional("RATE_LIMIT_PER_MINUTE", "30")), "RATE_LIMIT_PER_MINUTE"),
    },
    stt: {
      provider: optional("STT_PROVIDER", "none"),
      apiKey: optional("STT_API_KEY", ""),
      model: optional("STT_MODEL", ""),
      endpoint: optional("STT_ENDPOINT", ""),
      localBin: optional("STT_LOCAL_BIN", "whisper"),
      language: optional("STT_LANGUAGE", ""),
    },
    log: {
      level: optional("LOG_LEVEL", "info"),
      file: resolvePath(optional("LOG_FILE", "./logs/codex-bridge.log")),
    },
  };
}

export const config = loadConfig();
