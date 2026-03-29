# Codex Bridge

飞书 & Telegram ↔ Codex CLI 桥接服务。通过聊天应用远程使用 Codex 的全部能力。

[English](README.md) | 中文

## 功能

- 🤖 **双平台支持**：同时连接 Telegram 和飞书
- ⚡ **Codex 全能力**：直接调用 `codex exec`，复用所有 Codex 功能
- 🔐 **安全防护**：User ID 白名单 + 速率限制 + 敏感信息过滤
- 📂 **Session 管理**：独立会话目录，完整记录对话和文件
- 📎 **文件收发**：支持通过聊天平台上传/下载文件，Codex 生成的文件自动发送
- 🖼️ **图片输入**：发送图片给 Codex 分析（通过 `-i` 参数）
- 🎤 **语音消息**：支持接收语音消息并保存
- 🧠 **文件上下文感知**：上传文件后，下一条消息 Codex 自动知道文件路径
- 🔧 **可扩展命令**：内置 + 自定义命令，易于添加新命令
- 🚀 **systemd 服务**：开机自启 + 守护进程

## 快速开始

### 方式一：交互式安装（推荐）

```bash
git clone https://github.com/huisu773/codex-bridge.git
cd codex-bridge
./setup.sh
```

安装脚本会：
1. 交互式输入所有必要的凭证
2. 安装依赖并编译项目
3. 安装并启用 systemd 服务

### 方式二：手动安装

```bash
cp .env.example .env
# 编辑 .env 填入你的配置
npm install
npm run build
npm start
```

### 前置要求

- **Node.js 18+**（测试环境：Node.js 22）
- **Codex CLI** 已安装并完成认证（`codex auth login`）
- **Telegram Bot** 令牌（从 [@BotFather](https://t.me/BotFather) 获取）
- **飞书自建应用**（需启用机器人能力）

## 配置

所有配置通过 `.env` 文件中的环境变量管理：

| 变量 | 必填 | 说明 |
|------|------|------|
| `TELEGRAM_BOT_TOKEN` | ✅ | Telegram 机器人令牌 |
| `ALLOWED_TELEGRAM_IDS` | ✅ | 允许的 Telegram 用户 ID（逗号分隔） |
| `FEISHU_APP_ID` | ✅ | 飞书应用 App ID |
| `FEISHU_APP_SECRET` | ✅ | 飞书应用 App Secret |
| `ALLOWED_FEISHU_IDS` | ✅ | 允许的飞书用户 Open ID（逗号分隔） |
| `FEISHU_VERIFICATION_TOKEN` | | 飞书 Verification Token |
| `FEISHU_ENCRYPT_KEY` | | 飞书 Encrypt Key |
| `CODEX_MODEL` | | 模型名称（默认：`gpt-5.3-codex`） |
| `CODEX_WORKING_DIR` | | 工作目录（默认：项目根目录） |
| `CODEX_BIN` | | Codex 二进制路径（自动检测） |
| `SESSION_DIR` | | 会话存储路径 |
| `WEBHOOK_PORT` | | 健康检查端口（默认：`9800`） |
| `RATE_LIMIT_PER_MINUTE` | | 每分钟最大请求数（默认：`30`） |
| `LOG_LEVEL` | | `debug` / `info` / `warn` / `error` |

### 飞书配置

1. 在[飞书开放平台](https://open.feishu.cn/app)创建自建应用
2. 添加 **机器人** 能力
3. 进入 **事件与回调** → 订阅方式选择 **使用长连接接收事件**
4. 订阅事件：`im.message.receive_v1`
5. 发布应用，并将机器人添加到聊天中

### Telegram 配置

1. 通过 [@BotFather](https://t.me/BotFather) 创建机器人 → 获取令牌
2. 向你的机器人发送 `/start`
3. 通过 [@userinfobot](https://t.me/userinfobot) 获取你的用户 ID

## 命令列表

### 原生命令

| 命令 | 说明 |
|------|------|
| `/new` | 创建新会话 |
| `/status` | 查看当前会话和账户状态 |
| `/model [name]` | 查看/切换 Codex 模型 |
| `/compact` | 压缩会话上下文 |
| `/sessions` | 列出所有会话 |
| `/resume` | 查看当前会话信息 |
| `/cancel` | 取消运行中的 Codex 任务 |
| `/clear` | 清除当前会话 |

### 自定义命令

| 命令 | 说明 |
|------|------|
| `/exec <cmd>` | 直接执行 Shell 命令 |
| `/cd <dir>` | 切换 Codex 工作目录 |
| `/config` | 查看运行时配置 |
| `/help` | 查看所有命令 |

### 直接对话

发送不带 `/` 前缀的消息即可直接与 Codex 对话。Codex 在配置的工作目录中执行，拥有完整的系统访问权限。

### 文件工作流

1. **发送文件**到聊天中 → 文件自动保存到会话目录和工作目录
2. **询问 Codex** 关于文件的问题 → Codex 自动获得文件路径上下文
3. **Codex 创建的文件** 会自动发送回聊天

### 图片与语音

- **发送图片**：Codex 通过 `-i` 参数接收图片进行分析
- **发送语音**：语音文件保存到工作目录，可以让 Codex 处理

## 架构

```
聊天消息 → 平台处理器 → 鉴权检查 → 命令路由
                                        ↓
                                  命令执行 / Codex Exec
                                        ↓
                                  会话记录
                                        ↓
                                  格式化回复 ← 自动发送新文件
```

## 会话存储

每个会话存储在 `SESSION_DIR/{日期}-{平台}-{哈希}/` 目录下：

```
2026-03-29-telegram-8e35d1b8/
├── meta.json            # 会话元数据 + 统计
├── conversation.txt     # 可读的对话日志
├── conversation.jsonl   # 结构化对话记录（JSONL）
├── generated/           # Codex 生成的文件
├── received/            # 用户上传的文件
└── files.jsonl          # 文件操作日志
```

## 服务管理

```bash
# 使用 systemd（运行 setup.sh 后）
systemctl start codex-bridge
systemctl stop codex-bridge
systemctl restart codex-bridge
systemctl status codex-bridge
journalctl -u codex-bridge -f     # 查看日志

# 健康检查
curl http://localhost:9800/health
```

## 开发

```bash
npm run build    # 编译 TypeScript
npm start        # 运行服务
```

## 安全

- **用户白名单**：仅允许指定用户与机器人交互
- **速率限制**：可配置的每分钟请求限制
- **输入净化**：防止命令注入
- **输出过滤**：自动屏蔽响应中的敏感信息（令牌、密钥等）
- **健康检查端口**：默认绑定 `127.0.0.1`，不对外暴露
- **完全访问模式**：Codex 以 `--dangerously-bypass-approvals-and-sandbox` 运行 — 请确保服务器安全

## 许可

MIT
