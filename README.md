# Codex Bridge

飞书 (Feishu) & Telegram ↔ Codex CLI bridge service. Use Codex remotely through your chat apps.

[English](#features) | [中文](README.zh-CN.md)

## Features

- 🤖 **Dual Platform**: Connects to both Telegram and Feishu simultaneously
- ⚡ **Full Codex Power**: Wraps `codex exec` directly — all Codex capabilities available
- 🔐 **Secure**: User ID whitelist + rate limiting + sensitive output filtering
- 📂 **Session Management**: Per-session directories with full conversation + file tracking
- 📎 **File I/O**: Upload/download files through chat; auto-sends files created by Codex
- 🖼️ **Image Input**: Send images for Codex to analyze (via `-i` flag)
- 🎤 **Voice Messages**: Receive and save voice messages from both platforms
- 🧠 **File Context Awareness**: Upload a file → Codex automatically knows about it in your next message
- 🔧 **Extensible Commands**: Built-in + custom commands, easy to add more
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
- **Telegram Bot** token from [@BotFather](https://t.me/BotFather)
- **Feishu App** (self-built) with bot capabilities enabled

## Configuration

All configuration is via environment variables in `.env`:

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | ✅ | Telegram bot token from @BotFather |
| `ALLOWED_TELEGRAM_IDS` | ✅ | Comma-separated Telegram user IDs |
| `FEISHU_APP_ID` | ✅ | Feishu app ID |
| `FEISHU_APP_SECRET` | ✅ | Feishu app secret |
| `ALLOWED_FEISHU_IDS` | ✅ | Comma-separated Feishu open IDs |
| `FEISHU_VERIFICATION_TOKEN` | | Feishu verification token |
| `FEISHU_ENCRYPT_KEY` | | Feishu encrypt key |
| `CODEX_MODEL` | | Model name (default: `gpt-5.3-codex`) |
| `CODEX_WORKING_DIR` | | Working directory (default: project root) |
| `CODEX_BIN` | | Path to codex binary (auto-detected) |
| `SESSION_DIR` | | Session storage path |
| `WEBHOOK_PORT` | | Health check port (default: `9800`) |
| `RATE_LIMIT_PER_MINUTE` | | Max requests per minute (default: `30`) |
| `STT_PROVIDER` | | Voice transcription: `groq` / `openai` / `openrouter` / `local` / `none` |
| `STT_API_KEY` | | API key for STT provider |
| `STT_MODEL` | | STT model (default varies by provider) |
| `STT_LANGUAGE` | | Language hint for transcription (e.g. `zh`, `en`) |
| `LOG_LEVEL` | | `debug` / `info` / `warn` / `error` |

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
| `/model [name]` | View or switch the Codex model |
| `/compact` | Compress session context |
| `/sessions` | List all sessions |
| `/resume` | View current session info |
| `/cancel` | Cancel running Codex task |
| `/clear` | Clear current session |

### Custom Commands

| Command | Description |
|---------|-------------|
| `/exec <cmd>` | Execute a shell command |
| `/cd <dir>` | Change Codex working directory |
| `/config` | View runtime configuration |
| `/help` | List all commands |

### Direct Chat

Send any message without a `/` prefix to chat with Codex directly. Codex executes in the configured working directory with full system access.

### File Workflow

1. **Send a file** in chat (with or without `/upload`) → saved to session + working directory
2. **Ask Codex** about the file in your next message → Codex automatically receives the file path context
3. **Files created by Codex** are auto-sent back to you in chat

### Image & Voice

- **Send an image**: Codex receives it via the `-i` flag for visual analysis
- **Send a voice message**: Automatically transcribed to text (if STT configured) and sent to Codex

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
                                              Command / Codex Exec
                                                    ↓
                                              Session Recording
                                                    ↓
                                              Format & Reply ← Auto-send new files
```

## Session Storage

Each session is stored in `SESSION_DIR/{date}-{platform}-{hash}/`:

```
2026-03-29-telegram-8e35d1b8/
├── meta.json            # Session metadata + stats
├── conversation.txt     # Human-readable conversation log
├── conversation.jsonl   # Structured conversation (JSONL)
├── generated/           # Files created by Codex
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
npm start        # Run the service
npm run dev      # Watch mode (if configured)
```

## Security

- **User ID whitelist**: Only specified users can interact with the bot
- **Rate limiting**: Configurable per-minute request limit
- **Input sanitization**: Command injection prevention
- **Output filtering**: Sensitive patterns (tokens, keys) are masked in responses
- **Health check port**: Binds to `127.0.0.1` by default — not exposed externally
- **Full access mode**: Codex runs without sandbox (`--dangerously-bypass-approvals-and-sandbox`) — ensure your server is properly secured

## License

MIT
