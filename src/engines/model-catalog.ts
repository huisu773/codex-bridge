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
