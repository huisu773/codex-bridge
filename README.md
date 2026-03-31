# Codex Bridge

飞书 (Feishu) & Telegram ↔ Codex / Copilot CLI bridge service. Use AI coding agents remotely through your chat apps.

[English](#features) | [中文](README.zh-CN.md)

## Features

- 🤖 **Dual Platform**: Connects to both Telegram and Feishu simultaneously
- ⚙️ **Dual Engine**: Switch between **Codex CLI** and **GitHub Copilot CLI** per chat
- ⚡ **Full Agent Power**: Wraps `codex exec` / `copilot-cli` — all capabilities available
- 🔄 **Multi-turn Sessions**: Automatic `--resume` for continuous conversations
- 🔐 **Secure**: User ID whitelist + rate limiting + sensitive output filtering
- 📂 **Session Management**: Per-session directories with full conversation + file tracking
- 📎 **File I/O**: Upload files through chat; files created by the engine are saved and reported
- 🖼️ **Image Input**: Send images for analysis (Codex via `-i` flag)
- 🎤 **Voice Messages**: Auto-transcribed to text (STT) and sent to the engine
- 📡 **Streaming**: Real-time streaming responses with progress indicators
- 🔧 **Extensible Commands**: Built-in + custom commands with Telegram autocomplete sync
- 🚀 **systemd Service**: Auto-start on boot, managed as a system daemon

## Quick Start

### Option A: Interactive Setup (Recommended)

```bash
git clone https://github.com/huisu773/codex-bridge.git
cd codex-bridge
./setup.sh
```

The setup script will:
1. Prompt for all required credentials
2. Install dependencies and build the project
3. Install and enable the systemd service

### Option B: Manual Setup

```bash
cp .env.example .env
# Edit .env with your credentials
npm install
npm run build
npm start
```

### Prerequisites

- **Node.js 18+** (tested with Node.js 22)
- **Codex CLI** installed and authenticated (`codex auth login`)
- **GitHub Copilot CLI** (optional) — `npm install -g @anthropic-ai/copilot` or similar
- **Telegram Bot** token from [@BotFather](https://t.me/BotFather)
- **Feishu App** (self-built) with bot capabilities enabled

## Configuration

All configuration is via environment variables in `.env`:

### Core

| Variable | Required | Description |
|----------|----------|-------------|
| `DEFAULT_ENGINE` | | Default engine: `codex` or `copilot` (default: `codex`) |
| `CODEX_MODEL` | | Model name (default: `gpt-5.3-codex`) |
| `CODEX_WORKING_DIR` | | Working directory (default: `~/codex-workspace`) |
| `CODEX_BIN` | | Path to codex binary (auto-detected) |
| `SESSION_DIR` | | Session storage path (default: `~/codex-workspace/sessions`) |
| `WEBHOOK_PORT` | | Health check port (default: `9800`) |

### Copilot Engine

| Variable | Default | Description |
|----------|---------|-------------|
| `COPILOT_BIN` | `copilot` | Path to Copilot CLI binary |
| `COPILOT_MODEL` | `claude-sonnet-4-20250514` | Default model for Copilot |
| `COPILOT_TIMEOUT_MS` | `600000` | Max execution time (10 min) |
| `COPILOT_AUTOPILOT` | `true` | Run in autopilot mode (`--autopilot`) |
| `COPILOT_ALLOW_ALL` | `true` | Allow all permissions (`--allow-all`) |

### Platform Credentials

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | ✅ | Telegram bot token from @BotFather |
| `ALLOWED_TELEGRAM_IDS` | ✅ | Comma-separated Telegram user IDs |
| `FEISHU_APP_ID` | ✅ | Feishu app ID |
| `FEISHU_APP_SECRET` | ✅ | Feishu app secret |
| `ALLOWED_FEISHU_IDS` | ✅ | Comma-separated Feishu open IDs |
| `FEISHU_VERIFICATION_TOKEN` | | Feishu verification token |
| `FEISHU_ENCRYPT_KEY` | | Feishu encrypt key |

### Other

| Variable | Description |
|----------|-------------|
| `RATE_LIMIT_PER_MINUTE` | Max requests per minute (default: `30`) |
| `STT_PROVIDER` | Voice transcription: `groq` / `openai` / `openrouter` / `local` / `none` |
| `STT_API_KEY` | API key for STT provider |
| `STT_MODEL` | STT model (default varies by provider) |
| `STT_LANGUAGE` | Language hint for transcription (e.g. `zh`, `en`) |
| `LOG_LEVEL` | `debug` / `info` / `warn` / `error` |

### Feishu Setup

1. Create a self-built app at [Feishu Open Platform](https://open.feishu.cn/app)
2. Add **Bot** capability
3. Go to **Events & Callbacks** → set subscription mode to **WebSocket long connection (长连接)**
4. Subscribe to event: `im.message.receive_v1`
5. Publish the app and add the bot to a chat

### Telegram Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) → get the token
2. Send `/start` to your bot
3. Get your user ID from [@userinfobot](https://t.me/userinfobot)

## Commands

### Native Commands

| Command | Description |
|---------|-------------|
| `/new` | Start a new session |
| `/status` | Show current session & account status |
| `/model [name]` | View or switch the model (no args = list available models) |
| `/compact` | Compress session context |
| `/sessions` | List all sessions |
| `/resume` | View current session info |
| `/cancel` | Cancel running task(s) |
| `/clear` | Clear current session |

### Custom Commands

| Command | Description |
|---------|-------------|
| `/exec <cmd>` | Execute a shell command |
| `/cd <dir>` | Change working directory |
| `/engine [codex\|copilot]` | View or switch the backend engine |
| `/config` | View runtime configuration |
| `/help` | List all commands |

### Direct Chat

Send any message without a `/` prefix to chat with the active engine. The engine executes in the configured working directory with full system access.

### Engine Switching

Use `/engine codex` or `/engine copilot` to switch the backend per chat. The default is set by the `DEFAULT_ENGINE` environment variable (default: `codex`). Engine selection persists across service restarts.

### Supported Models

Use `/model` (no arguments) to see all available models for the current engine. Use `/model <name>` to switch.

**Codex Engine (OpenAI):**

| Model | Description |
|-------|-------------|
| `gpt-5.4` ⭐ | GPT-5.4 — flagship reasoning & coding |
| `gpt-5.4-mini` | GPT-5.4 Mini — fast & lightweight |
| `gpt-5.3-codex` | GPT-5.3 Codex — complex projects |
| `gpt-5.2-codex` | GPT-5.2 Codex — agentic coding |
| `gpt-5.1-codex-max` | GPT-5.1 Codex Max — project-scale tasks |
| `gpt-5.1-codex` | GPT-5.1 Codex |
| `o4-mini` | O4 Mini — fast reasoning |
| `o3` | O3 — reasoning model |
| `codex-mini-latest` | Codex Mini — low-latency |
| `gpt-4.1` | GPT-4.1 |

**Copilot Engine (multi-provider):**

| Model | Description |
|-------|-------------|
| `claude-sonnet-4.6` ⭐ | Claude Sonnet 4.6 — latest balanced |
| `claude-opus-4.6` | Claude Opus 4.6 — deep reasoning |
| `claude-haiku-4.5` | Claude Haiku 4.5 — fast & light |
| `gpt-5.4` | GPT-5.4 |
| `gpt-5.3-codex` | GPT-5.3 Codex |
| `gemini-2.5-pro` | Gemini 2.5 Pro |
| `gemini-3-flash` | Gemini 3 Flash (preview) |

> Models marked ⭐ are recommended defaults. Available models may vary by account plan.

### File Workflow

1. **Send a file** in chat → saved to session `received/` directory
2. **Ask about the file** in your next message → the engine automatically receives the file path context
3. **Files created by the engine** are saved to session `generated/` directory and reported in the reply

> Files are stored in session directories, not the workspace root.

### Image & Voice

- **Send an image**: analyzed via the engine (Codex uses `-i` flag; Copilot ignores images)
- **Send a voice message**: automatically transcribed to text (if STT configured)

#### STT Provider Setup

| Provider | API Key | Default Model | Notes |
|----------|---------|---------------|-------|
| `groq` | Groq API key | `whisper-large-v3-turbo` | Fast, free tier available |
| `openai` | OpenAI API key | `whisper-1` | Official OpenAI |
| `openrouter` | OpenRouter key | `openai/whisper-large-v3` | Proxied access |
| `local` | Not needed | `base` | Requires `whisper` binary installed |
| `none` | — | — | Voice saved as file only |

## Architecture

```
Chat Message → Platform Handler → Auth Check → Command Router
                                                    ↓
                                              Command / Engine Exec
                                                    ↓
                                              ┌─────┴─────┐
                                              │  engines/  │
                                              ├────────────┤
                                              │   codex    │  codex exec (JSONL)
                                              │   copilot  │  copilot-cli (JSONL)
                                              └─────┬──────┘
                                                    ↓
                                              Session Recording
                                                    ↓
                                              Format & Reply
```

### Source Structure

```
src/
├── index.ts                  # Entry point, graceful shutdown
├── config.ts                 # Environment-based configuration
├── engines/                  # Unified engine abstraction
│   ├── types.ts              # EngineExecutor interface, ExecOptions/Result
│   ├── index.ts              # Engine factory, per-chat overrides
│   ├── codex.ts              # Codex CLI executor (JSONL)
│   ├── copilot.ts            # Copilot CLI executor (JSONL)
│   └── file-snapshot.ts      # Shared file change detection
├── commands/                 # Command handlers
│   ├── registry.ts           # Command registry
│   ├── native.ts             # Orchestrator (delegates to below)
│   ├── session-commands.ts   # /new, /status, /model, /cancel, etc.
│   ├── passthrough.ts        # Non-command message → engine routing
│   ├── custom.ts             # /exec, /cd, /engine, /config
│   ├── help.ts               # /help
│   └── utils.ts              # Shared: buildPrompt, classifyError, enqueueChatTask
├── core/                     # Core logic
│   ├── command-router.ts     # Routes messages to commands
│   ├── session-manager.ts    # Session lifecycle, persistence, file management
│   └── stt-provider.ts       # Voice-to-text (Groq, OpenAI, local whisper)
├── platforms/                # Chat platform adapters
│   ├── types.ts              # PlatformMessage, PlatformFile interfaces
│   ├── common.ts             # Shared: MessageDeduplicator
│   ├── telegram/             # Telegram bot, handler, formatter
│   └── feishu/               # Feishu bot, handler, formatter
├── security/                 # Auth, rate limiting, input sanitization
│   └── auth.ts
├── session/                  # Session type definitions
│   └── types.ts
└── utils/                    # Logging, metrics, helpers, retry
    ├── logger.ts
    ├── metrics.ts
    ├── helpers.ts
    └── retry.ts
```

### Platform Formatting

- **Feishu**: Rich formatting via `lark_md` (bold, code, links, lists) with streaming card updates
- **Telegram**: Plain text output for maximum compatibility; slash commands auto-synced to menu

## Session Storage

Each session is stored in `SESSION_DIR/{date}-{platform}-{hash}/`. Using `/new` creates a new session folder while preserving the previous one on disk.

```
2026-03-29-telegram-8e35d1b8/
├── meta.json            # Session metadata + stats
├── conversation.txt     # Human-readable conversation log
├── conversation.jsonl   # Structured conversation (JSONL)
├── generated/           # Files created by engine
├── received/            # Files uploaded by user
└── files.jsonl          # File operation log
```

## Service Management

```bash
# With systemd (after setup.sh)
systemctl start codex-bridge
systemctl stop codex-bridge
systemctl restart codex-bridge
systemctl status codex-bridge
journalctl -u codex-bridge -f     # Follow logs

# Health check
curl http://localhost:9800/health
```

## Development

```bash
npm run build    # Compile TypeScript
npm run lint     # Type check (tsc --noEmit)
npm start        # Run the service
npm run dev      # Watch mode
```

## Security

- **User ID whitelist**: Only specified users can interact with the bot
- **Rate limiting**: Configurable per-minute request limit
- **Input sanitization**: Command injection prevention
- **Output filtering**: Sensitive patterns (tokens, keys) are masked in responses
- **Health check port**: Binds to `127.0.0.1` by default — not exposed externally
- **Copilot mode**: Runs with `--autopilot --allow-all` by default (configurable via env vars)
- **Codex mode**: Runs without sandbox (`--dangerously-bypass-approvals-and-sandbox`) — ensure your server is properly secured

## License

MIT
