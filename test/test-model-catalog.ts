import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CODEX_MODELS, COPILOT_MODELS, CLAUDE_MODELS } from "../src/engines/model-catalog.js";

interface DocModel {
  id: string;
  description: string;
  recommended: boolean;
}

function parseSectionModels(content: string, sectionTitle: string): DocModel[] {
  const lines = content.split("\n");
  const sectionIdx = lines.findIndex((line) => line.trim() === sectionTitle);
  if (sectionIdx < 0) {
    throw new Error(`Section not found: ${sectionTitle}`);
  }

  const out: DocModel[] = [];
  for (let i = sectionIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("| `")) {
      if (out.length > 0) break;
      continue;
    }
    const cells = line.split("|").map((c) => c.trim()).filter(Boolean);
    if (cells.length < 2) continue;
    const modelCell = cells[0];
    const descCell = cells[1];
    const id = modelCell.replace(/`/g, "").replace("⭐", "").trim();
    out.push({
      id,
      description: descCell,
      recommended: modelCell.includes("⭐"),
    });
  }
  return out;
}

function normalizeCodeModels(models: typeof CODEX_MODELS): DocModel[] {
  return models.map((m) => ({
    id: m.id,
    description: m.description || "",
    recommended: Boolean(m.recommended),
  }));
}

function assertEqual(name: string, actual: DocModel[], expected: DocModel[]) {
  const a = JSON.stringify(actual, null, 2);
  const b = JSON.stringify(expected, null, 2);
  if (a !== b) {
    throw new Error(`${name} mismatch.\nActual:\n${a}\nExpected:\n${b}`);
  }
}

const root = process.cwd();
const readme = readFileSync(join(root, "README.md"), "utf8");

const docCodexModels = parseSectionModels(readme, "**Codex Engine (OpenAI):**");
const docCopilotModels = parseSectionModels(readme, "**Copilot Engine (multi-provider):**");
const docClaudeModels = parseSectionModels(readme, "**Claude Code Engine (OpenRouter):**");

assertEqual("Codex models", normalizeCodeModels(CODEX_MODELS), docCodexModels);
assertEqual("Copilot models", normalizeCodeModels(COPILOT_MODELS), docCopilotModels);
assertEqual("Claude models", normalizeCodeModels(CLAUDE_MODELS), docClaudeModels);

console.log("OK: model catalog matches README supported models tables (Codex + Copilot + Claude).");
