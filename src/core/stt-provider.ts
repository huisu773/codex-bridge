/**
 * Speech-to-Text (STT) Provider System
 *
 * Supports multiple backends:
 *   - groq:    Groq API (Whisper models, fast & free tier)
 *   - openai:  OpenAI official Whisper API
 *   - openrouter: OpenRouter API (proxied Whisper)
 *   - local:   Local whisper binary (whisper.cpp or openai-whisper)
 *   - none:    Disabled — voice files saved but not transcribed
 */

import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { logger } from "../utils/logger.js";

export type STTProvider = "groq" | "openai" | "openrouter" | "local" | "none";

export interface STTConfig {
  provider: STTProvider;
  apiKey: string;
  model: string;
  endpoint: string;
  localBin: string;
  language: string;
}

export interface STTResult {
  success: boolean;
  text: string;
  duration?: number;
  provider: STTProvider;
  error?: string;
}

const DEFAULT_ENDPOINTS: Record<string, string> = {
  groq: "https://api.groq.com/openai/v1/audio/transcriptions",
  openai: "https://api.openai.com/v1/audio/transcriptions",
  openrouter: "https://openrouter.ai/api/v1/audio/transcriptions",
};

const DEFAULT_MODELS: Record<string, string> = {
  groq: "whisper-large-v3-turbo",
  openai: "whisper-1",
  openrouter: "openai/whisper-large-v3",
  local: "base",
};

/** Validate language code to prevent injection (BCP-47 format) */
function isValidLanguage(lang: string): boolean {
  return /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{1,8})?$/.test(lang);
}

/**
 * Convert audio to WAV format using ffmpeg (required for some APIs).
 * Returns path to the converted file.
 */
function convertToWav(inputPath: string): string {
  const outPath = join(tmpdir(), `stt-${randomUUID().slice(0, 8)}.wav`);
  try {
    execFileSync("ffmpeg", [
      "-y", "-i", inputPath,
      "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
      outPath,
    ], { timeout: 30_000, stdio: ["pipe", "pipe", "pipe"] });
    return outPath;
  } catch {
    logger.warn({ inputPath }, "ffmpeg conversion failed, using original file");
    return inputPath;
  }
}

/**
 * Transcribe using an OpenAI-compatible API (Groq, OpenAI, OpenRouter).
 * All three use the same multipart/form-data format.
 */
async function transcribeViaAPI(
  filePath: string,
  config: STTConfig,
): Promise<STTResult> {
  const endpoint = config.endpoint || DEFAULT_ENDPOINTS[config.provider] || "";
  const model = config.model || DEFAULT_MODELS[config.provider] || "whisper-1";

  if (!config.apiKey) {
    return {
      success: false,
      text: "",
      provider: config.provider,
      error: `STT_API_KEY not configured for ${config.provider}`,
    };
  }

  // Convert to WAV for better compatibility
  const wavPath = convertToWav(filePath);

  try {
    const formData = new FormData();
    const fileBuffer = await import("node:fs").then((fs) =>
      fs.readFileSync(wavPath),
    );
    const blob = new Blob([fileBuffer], { type: "audio/wav" });
    formData.append("file", blob, "audio.wav");
    formData.append("model", model);
    if (config.language) {
      formData.append("language", config.language);
    }
    formData.append("response_format", "json");

    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: formData,
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return {
        success: false,
        text: "",
        provider: config.provider,
        error: `API error ${resp.status}: ${errText.slice(0, 200)}`,
      };
    }

    const data = (await resp.json()) as { text?: string; duration?: number };
    return {
      success: true,
      text: data.text || "",
      duration: data.duration,
      provider: config.provider,
    };
  } catch (err: any) {
    return {
      success: false,
      text: "",
      provider: config.provider,
      error: err.message,
    };
  } finally {
    // Clean up temp WAV file synchronously to prevent leaks
    if (wavPath !== filePath) {
      try { unlinkSync(wavPath); } catch {}
    }
  }
}

/**
 * Transcribe using a local whisper binary (whisper.cpp or openai-whisper).
 */
async function transcribeLocal(
  filePath: string,
  config: STTConfig,
): Promise<STTResult> {
  const bin = config.localBin || "whisper";
  const model = config.model || "base";

  // Check if binary exists
  try {
    execFileSync("which", [bin], { stdio: "ignore" });
  } catch {
    return {
      success: false,
      text: "",
      provider: "local",
      error: `Local whisper binary not found: ${bin}. Install with: pip install openai-whisper`,
    };
  }

  const wavPath = convertToWav(filePath);
  const outDir = tmpdir();

  try {
    const args = [wavPath, "--model", model, "--output_format", "txt", "--output_dir", outDir];
    if (config.language) {
      if (!isValidLanguage(config.language)) {
        return { success: false, text: "", provider: "local", error: `Invalid language code: ${config.language}` };
      }
      args.push("--language", config.language);
    }
    execFileSync(bin, args, { timeout: 120_000, stdio: ["pipe", "pipe", "pipe"] });

    // Read the output .txt file
    const baseName = wavPath.split("/").pop()?.replace(/\.[^.]+$/, "") || "audio";
    const txtPath = join(outDir, `${baseName}.txt`);
    if (existsSync(txtPath)) {
      const { readFileSync } = await import("node:fs");
      const text = readFileSync(txtPath, "utf-8").trim();
      return { success: true, text, provider: "local" };
    }

    return {
      success: false,
      text: "",
      provider: "local",
      error: "Whisper produced no output",
    };
  } catch (err: any) {
    return {
      success: false,
      text: "",
      provider: "local",
      error: err.message?.slice(0, 200),
    };
  } finally {
    // Clean up temp WAV file synchronously to prevent leaks
    if (wavPath !== filePath) {
      try { unlinkSync(wavPath); } catch {}
    }
  }
}

/**
 * Main transcription function. Routes to the configured provider.
 */
export async function transcribe(
  filePath: string,
  config: STTConfig,
): Promise<STTResult> {
  if (config.provider === "none") {
    return { success: false, text: "", provider: "none", error: "STT disabled" };
  }

  if (!existsSync(filePath)) {
    return {
      success: false,
      text: "",
      provider: config.provider,
      error: `File not found: ${filePath}`,
    };
  }

  const size = statSync(filePath).size;
  if (size > 25 * 1024 * 1024) {
    return {
      success: false,
      text: "",
      provider: config.provider,
      error: "Audio file too large (>25MB)",
    };
  }

  logger.info(
    { provider: config.provider, model: config.model, file: filePath, sizeMB: (size / 1024 / 1024).toFixed(1) },
    "Transcribing audio",
  );

  const start = Date.now();
  let result: STTResult;

  switch (config.provider) {
    case "groq":
    case "openai":
    case "openrouter":
      result = await transcribeViaAPI(filePath, config);
      break;
    case "local":
      result = await transcribeLocal(filePath, config);
      break;
    default:
      result = { success: false, text: "", provider: config.provider, error: `Unknown provider: ${config.provider}` };
  }

  const elapsed = Date.now() - start;
  if (result.success) {
    logger.info(
      { provider: config.provider, elapsed, textLen: result.text.length },
      "Transcription complete",
    );
  } else {
    logger.error(
      { provider: config.provider, elapsed, error: result.error },
      "Transcription failed",
    );
  }

  return result;
}
