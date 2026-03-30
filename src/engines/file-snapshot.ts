/**
 * Directory snapshot utilities for detecting new/modified files
 * after an engine execution completes.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Take a snapshot of file modification times in a directory. */
export async function snapshotDir(dir: string): Promise<Map<string, number>> {
  const snap = new Map<string, number>();
  try {
    const { stdout } = await execFileAsync("find", [
      dir,
      "-maxdepth", "3",
      "-type", "f",
      "-not", "-path", "*/node_modules/*",
      "-not", "-path", "*/.git/*",
      "-not", "-path", "*/logs/*",
      "-not", "-name", "*.log",
      "-not", "-name", "*.sqlite*",
      "-not", "-name", "*.lock",
      "-not", "-name", "package-lock.json",
      "-not", "-path", "*/dist/*",
      "-not", "-path", "*/.codex/*",
      "-not", "-path", "*/sessions/*",
      "-printf", "%T@ %p\\n",
    ], { encoding: "utf-8", timeout: 5000, maxBuffer: 5 * 1024 * 1024 });
    const lines = stdout.trim().split("\n").filter(Boolean).slice(0, 5000);
    for (const line of lines) {
      const spaceIdx = line.indexOf(" ");
      if (spaceIdx > 0) {
        const mtime = parseFloat(line.slice(0, spaceIdx));
        const path = line.slice(spaceIdx + 1);
        snap.set(path, mtime);
      }
    }
  } catch {
    // Ignore snapshot errors — not all environments have GNU find
  }
  return snap;
}

/** Compare two snapshots and return paths of new or modified files. */
export function diffSnapshots(
  before: Map<string, number>,
  after: Map<string, number>,
): string[] {
  const newFiles: string[] = [];
  for (const [path, mtime] of after) {
    const prevMtime = before.get(path);
    if (prevMtime === undefined || mtime > prevMtime) {
      newFiles.push(path);
    }
  }
  return newFiles;
}
