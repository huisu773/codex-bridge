import type { EngineModelInfo } from "./types.js";

export const CODEX_MODELS: EngineModelInfo[] = [
  { id: "gpt-5.4-mini", description: "GPT-5.4 Mini — fast & lightweight", recommended: true },
  { id: "gpt-5.4", description: "GPT-5.4 — flagship reasoning & coding" },
  { id: "gpt-5.3-codex", description: "GPT-5.3 Codex — complex projects" },
];

export const COPILOT_MODELS: EngineModelInfo[] = [
  { id: "gpt-5-mini", description: "GPT-5 Mini", recommended: true },
  { id: "claude-sonnet-4.6", description: "Claude Sonnet 4.6 — latest balanced" },
  { id: "claude-opus-4.6", description: "Claude Opus 4.6 — deep reasoning" },
  { id: "claude-haiku-4.5", description: "Claude Haiku 4.5 — fast & light" },
  { id: "gpt-5.4", description: "GPT-5.4" },
  { id: "gpt-5.3-codex", description: "GPT-5.3 Codex" },
  { id: "gpt-4o", description: "GPT-4o" },
  { id: "gpt-4.1", description: "GPT-4.1" },
  { id: "gemini-3.1-pro", description: "Gemini 3.1 Pro" },
  { id: "gemini-3-flash", description: "Gemini 3 Flash" },
];

export const CLAUDE_MODELS: EngineModelInfo[] = [
  { id: "qwen/qwen3.6-plus:free", description: "Qwen 3.6 Plus — free via OpenRouter", recommended: true },
  { id: "minimax/minimax-m2.5:free", description: "MiniMax M2.5 — free via OpenRouter" },
  { id: "minimax/minimax-m2.7", description: "MiniMax M2.7 — via OpenRouter" },
  { id: "z-ai/glm-5", description: "Z.ai GLM-5 — via OpenRouter" },
  { id: "moonshotai/kimi-k2.5", description: "Moonshot Kimi K2.5 — via OpenRouter" },
  { id: "sonnet", description: "Claude Sonnet — latest balanced" },
  { id: "opus", description: "Claude Opus — deep reasoning" },
  { id: "haiku", description: "Claude Haiku — fast & light" },
];
