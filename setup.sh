#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════
#  Codex Bridge — Interactive Setup Script
#  Sets up .env, builds the project, installs systemd service
# ═══════════════════════════════════════════════════════════════

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"
ENV_EXAMPLE="$SCRIPT_DIR/.env.example"
SERVICE_FILE="$SCRIPT_DIR/codex-bridge.service"
SYSTEMD_DEST="/etc/systemd/system/codex-bridge.service"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${CYAN}ℹ${NC}  $*"; }
ok()    { echo -e "${GREEN}✓${NC}  $*"; }
warn()  { echo -e "${YELLOW}⚠${NC}  $*"; }
err()   { echo -e "${RED}✗${NC}  $*"; }

header() {
  echo ""
  echo -e "${BOLD}═══════════════════════════════════════════════════${NC}"
  echo -e "${BOLD}  $*${NC}"
  echo -e "${BOLD}═══════════════════════════════════════════════════${NC}"
  echo ""
}

# Prompt for a value with default
# Usage: prompt_value "description" "ENV_KEY" "default_value" [required]
prompt_value() {
  local desc="$1" key="$2" default="${3:-}" required="${4:-}"
  local current=""

  # Check if already set in existing .env
  if [[ -f "$ENV_FILE" ]]; then
    current=$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)
  fi
  # Fall back to environment variable
  if [[ -z "$current" ]]; then
    current="${!key:-}"
  fi

  local prompt_text="  ${desc}"
  if [[ -n "$current" ]]; then
    # Mask sensitive values
    if [[ "$key" == *TOKEN* || "$key" == *SECRET* || "$key" == *KEY* ]]; then
      local masked="${current:0:6}...${current: -4}"
      prompt_text="${prompt_text} [${masked}]"
    else
      prompt_text="${prompt_text} [${current}]"
    fi
  elif [[ -n "$default" ]]; then
    prompt_text="${prompt_text} [${default}]"
  fi

  echo -en "${prompt_text}: "
  read -r value

  if [[ -z "$value" ]]; then
    value="${current:-$default}"
  fi

  if [[ "$required" == "required" && -z "$value" ]]; then
    err "This field is required."
    prompt_value "$desc" "$key" "$default" "$required"
    return
  fi

  # Store in associative array
  ENV_VALUES["$key"]="$value"
}

# ─── Pre-checks ──────────────────────────────────────────────
header "Codex Bridge Setup"

info "Project directory: $SCRIPT_DIR"

# Check Node.js
if ! command -v node &>/dev/null; then
  err "Node.js is not installed. Please install Node.js 18+ first."
  exit 1
fi
NODE_VER=$(node -v)
ok "Node.js $NODE_VER detected"

# Check npm
if ! command -v npm &>/dev/null; then
  err "npm is not installed."
  exit 1
fi
ok "npm $(npm -v) detected"

# Check codex CLI
CODEX_BIN_DEFAULT=""
if command -v codex &>/dev/null; then
  CODEX_BIN_DEFAULT=$(which codex)
  ok "Codex CLI found at $CODEX_BIN_DEFAULT"
else
  warn "Codex CLI not found in PATH. You'll need to specify the path."
fi

# ─── Load existing .env if present ───────────────────────────
if [[ -f "$ENV_FILE" ]]; then
  info "Found existing .env file — values will be used as defaults"
fi

# ─── Interactive Configuration ───────────────────────────────
declare -A ENV_VALUES

header "Telegram Configuration"
info "Get your bot token from @BotFather on Telegram"
info "Get your user ID from @userinfobot on Telegram"
echo ""
prompt_value "Bot Token" "TELEGRAM_BOT_TOKEN" "" "required"
prompt_value "Allowed User IDs (comma-separated)" "ALLOWED_TELEGRAM_IDS" "" "required"

header "Feishu (飞书) Configuration"
info "Create a bot at https://open.feishu.cn/app"
info "Enable WebSocket long connection in Events & Callbacks"
echo ""
prompt_value "App ID" "FEISHU_APP_ID" "" "required"
prompt_value "App Secret" "FEISHU_APP_SECRET" "" "required"
prompt_value "Verification Token" "FEISHU_VERIFICATION_TOKEN" ""
prompt_value "Encrypt Key" "FEISHU_ENCRYPT_KEY" ""
prompt_value "Allowed User Open IDs (comma-separated)" "ALLOWED_FEISHU_IDS" "" "required"

header "Codex Settings"
prompt_value "Codex CLI path" "CODEX_BIN" "$CODEX_BIN_DEFAULT" "required"

# Verify Codex CLI is callable
CODEX_PATH="${ENV_VALUES[CODEX_BIN]}"
if [[ -n "$CODEX_PATH" ]]; then
  if [[ -x "$CODEX_PATH" ]] || command -v "$CODEX_PATH" &>/dev/null; then
    CODEX_VER=$("$CODEX_PATH" --version 2>/dev/null || echo "unknown")
    ok "Codex CLI verified: $CODEX_VER"
  else
    warn "Cannot verify Codex CLI at '$CODEX_PATH' — it may not be installed or not in PATH"
  fi
fi

prompt_value "Default model" "CODEX_MODEL" "gpt-5.3-codex"
prompt_value "Copilot default model" "COPILOT_MODEL" "gpt-5-mini"
prompt_value "Default engine (codex|copilot)" "DEFAULT_ENGINE" "codex"
prompt_value "Working directory" "CODEX_WORKING_DIR" "$HOME/codex-workspace"

header "Server & Storage"
prompt_value "Health check port" "WEBHOOK_PORT" "9800"
prompt_value "Health check host" "WEBHOOK_HOST" "127.0.0.1"
prompt_value "Session directory" "SESSION_DIR" "$HOME/codex-workspace/sessions"
prompt_value "Session max age (hours)" "SESSION_MAX_AGE_HOURS" "168"

header "Security & Logging"
prompt_value "Rate limit (requests/min)" "RATE_LIMIT_PER_MINUTE" "30"
prompt_value "Log level (debug/info/warn/error)" "LOG_LEVEL" "info"
prompt_value "Log file path" "LOG_FILE" "./logs/codex-bridge.log"

header "Speech-to-Text (Voice Messages)"
info "Supported providers: groq, openai, openrouter, local, none"
info "  groq      — Fast & free tier (recommended)"
info "  openai    — OpenAI official Whisper API"
info "  openrouter — OpenRouter proxied Whisper"
info "  local     — Local whisper binary (whisper.cpp / openai-whisper)"
info "  none      — Disabled (voice files saved but not transcribed)"
echo ""
prompt_value "STT provider" "STT_PROVIDER" "none"
if [[ "${ENV_VALUES[STT_PROVIDER]}" != "none" && "${ENV_VALUES[STT_PROVIDER]}" != "local" ]]; then
  prompt_value "STT API key" "STT_API_KEY" "" "required"
fi
prompt_value "STT model (leave empty for default)" "STT_MODEL" ""
prompt_value "STT language hint (e.g. zh, en; empty=auto)" "STT_LANGUAGE" ""
if [[ "${ENV_VALUES[STT_PROVIDER]}" == "local" ]]; then
  prompt_value "Local whisper binary path" "STT_LOCAL_BIN" "whisper"
fi

# ─── Write .env ──────────────────────────────────────────────
header "Writing Configuration"

# Backup existing .env before overwriting
if [[ -f "$ENV_FILE" ]]; then
  BACKUP="$ENV_FILE.bak.$(date +%Y%m%d_%H%M%S)"
  cp "$ENV_FILE" "$BACKUP"
  ok "Backed up existing .env to $BACKUP"
fi

cat > "$ENV_FILE" << ENVEOF
# Codex Bridge — Configuration
# Generated by setup.sh on $(date -Iseconds)

# ---- Telegram ----
TELEGRAM_BOT_TOKEN=${ENV_VALUES[TELEGRAM_BOT_TOKEN]}
ALLOWED_TELEGRAM_IDS=${ENV_VALUES[ALLOWED_TELEGRAM_IDS]}

# ---- Feishu (飞书) ----
FEISHU_APP_ID=${ENV_VALUES[FEISHU_APP_ID]}
FEISHU_APP_SECRET=${ENV_VALUES[FEISHU_APP_SECRET]}
FEISHU_VERIFICATION_TOKEN=${ENV_VALUES[FEISHU_VERIFICATION_TOKEN]:-}
FEISHU_ENCRYPT_KEY=${ENV_VALUES[FEISHU_ENCRYPT_KEY]:-}
ALLOWED_FEISHU_IDS=${ENV_VALUES[ALLOWED_FEISHU_IDS]}

# ---- Server ----
WEBHOOK_PORT=${ENV_VALUES[WEBHOOK_PORT]}
WEBHOOK_HOST=${ENV_VALUES[WEBHOOK_HOST]}

# ---- Codex ----
CODEX_MODEL=${ENV_VALUES[CODEX_MODEL]}
CODEX_WORKING_DIR=${ENV_VALUES[CODEX_WORKING_DIR]}
CODEX_BIN=${ENV_VALUES[CODEX_BIN]}

# ---- Copilot ----
COPILOT_MODEL=${ENV_VALUES[COPILOT_MODEL]:-gpt-5-mini}

# ---- Engine ----
DEFAULT_ENGINE=${ENV_VALUES[DEFAULT_ENGINE]:-codex}

# ---- Session ----
SESSION_DIR=${ENV_VALUES[SESSION_DIR]}
SESSION_MAX_AGE_HOURS=${ENV_VALUES[SESSION_MAX_AGE_HOURS]}

# ---- Security ----
RATE_LIMIT_PER_MINUTE=${ENV_VALUES[RATE_LIMIT_PER_MINUTE]}

# ---- Speech-to-Text ----
STT_PROVIDER=${ENV_VALUES[STT_PROVIDER]:-none}
STT_API_KEY=${ENV_VALUES[STT_API_KEY]:-}
STT_MODEL=${ENV_VALUES[STT_MODEL]:-}
STT_ENDPOINT=${ENV_VALUES[STT_ENDPOINT]:-}
STT_LOCAL_BIN=${ENV_VALUES[STT_LOCAL_BIN]:-whisper}
STT_LANGUAGE=${ENV_VALUES[STT_LANGUAGE]:-}

# ---- Logging ----
LOG_LEVEL=${ENV_VALUES[LOG_LEVEL]}
LOG_FILE=${ENV_VALUES[LOG_FILE]}
ENVEOF

chmod 600 "$ENV_FILE"
ok "Configuration saved to $ENV_FILE (permissions: 600)"

# ─── Install Dependencies ────────────────────────────────────
header "Installing Dependencies"

cd "$SCRIPT_DIR"
npm install --no-fund --no-audit 2>&1 | tail -3
ok "Dependencies installed"

# ─── Build ───────────────────────────────────────────────────
header "Building Project"

npm run build 2>&1
ok "TypeScript build complete"

# ─── Create directories ─────────────────────────────────────
mkdir -p "${ENV_VALUES[SESSION_DIR]}"
mkdir -p "$SCRIPT_DIR/logs"
ok "Created session and log directories"

# ─── Systemd Service ────────────────────────────────────────
header "Systemd Service"

if [[ ! -f "$SERVICE_FILE" ]]; then
  err "Service file not found at $SERVICE_FILE"
  exit 1
fi

echo -en "  Install and enable systemd service? [Y/n]: "
read -r install_service
install_service="${install_service:-Y}"

if [[ "$install_service" =~ ^[Yy]$ ]]; then
  # Update service file paths to match config
  sed -e "s|WorkingDirectory=.*|WorkingDirectory=$SCRIPT_DIR|" \
      -e "s|ExecStart=.*|ExecStart=$(which node) $SCRIPT_DIR/dist/index.js|" \
      -e "s|EnvironmentFile=.*|EnvironmentFile=$ENV_FILE|" \
      -e "s|StandardOutput=.*|StandardOutput=append:$SCRIPT_DIR/logs/systemd.log|" \
      -e "s|StandardError=.*|StandardError=append:$SCRIPT_DIR/logs/systemd-error.log|" \
      "$SERVICE_FILE" > "$SYSTEMD_DEST"

  systemctl daemon-reload
  systemctl enable codex-bridge
  ok "Service installed and enabled"

  echo -en "  Start the service now? [Y/n]: "
  read -r start_now
  start_now="${start_now:-Y}"

  if [[ "$start_now" =~ ^[Yy]$ ]]; then
    # Kill any running instance
    if pgrep -f 'node.*codex-bridge/dist/index.js' >/dev/null 2>&1; then
      warn "Stopping existing codex-bridge process..."
      pgrep -f 'node.*codex-bridge/dist/index.js' | xargs kill 2>/dev/null || true
      sleep 2
    fi
    systemctl start codex-bridge
    sleep 2
    if systemctl is-active --quiet codex-bridge; then
      ok "Service started successfully!"
    else
      err "Service failed to start. Check logs:"
      echo "  journalctl -u codex-bridge -n 20 --no-pager"
    fi
  fi
else
  info "Skipped systemd installation."
  info "You can manually start with: cd $SCRIPT_DIR && node dist/index.js"
fi

# ─── Summary ─────────────────────────────────────────────────
header "Setup Complete! 🎉"

echo -e "  ${BOLD}Useful Commands:${NC}"
echo ""
echo -e "  ${CYAN}Start:${NC}    systemctl start codex-bridge"
echo -e "  ${CYAN}Stop:${NC}     systemctl stop codex-bridge"
echo -e "  ${CYAN}Restart:${NC}  systemctl restart codex-bridge"
echo -e "  ${CYAN}Status:${NC}   systemctl status codex-bridge"
echo -e "  ${CYAN}Logs:${NC}     journalctl -u codex-bridge -f"
echo ""
echo -e "  ${BOLD}Config:${NC}   $ENV_FILE"
echo -e "  ${BOLD}Sessions:${NC} ${ENV_VALUES[SESSION_DIR]}"
echo -e "  ${BOLD}Health:${NC}   http://localhost:${ENV_VALUES[WEBHOOK_PORT]}/health"
echo ""
