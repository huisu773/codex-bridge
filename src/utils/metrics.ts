/**
 * In-memory service metrics for health checks and /status command.
 */

const startTime = Date.now();

interface CodexStats {
  total: number;
  success: number;
  failed: number;
  timedOut: number;
  totalDurationMs: number;
}

interface CopilotStats {
  total: number;
  success: number;
  failed: number;
  timedOut: number;
  totalDurationMs: number;
  totalAskUserRounds: number;
}

const state = {
  telegram: "disconnected" as string,
  feishu: "disconnected" as string,
  codex: { total: 0, success: 0, failed: 0, timedOut: 0, totalDurationMs: 0 } as CodexStats,
  copilot: { total: 0, success: 0, failed: 0, timedOut: 0, totalDurationMs: 0, totalAskUserRounds: 0 } as CopilotStats,
};

export function setPlatformStatus(platform: "telegram" | "feishu", status: string): void {
  state[platform] = status;
}

export function recordCodexExecution(success: boolean, durationMs: number, timedOut: boolean): void {
  state.codex.total++;
  if (success) state.codex.success++;
  else state.codex.failed++;
  if (timedOut) state.codex.timedOut++;
  state.codex.totalDurationMs += durationMs;
}

export function recordCopilotExecution(success: boolean, durationMs: number, timedOut: boolean, askUserRounds: number): void {
  state.copilot.total++;
  if (success) state.copilot.success++;
  else state.copilot.failed++;
  if (timedOut) state.copilot.timedOut++;
  state.copilot.totalDurationMs += durationMs;
  state.copilot.totalAskUserRounds += askUserRounds;
}

export function getServiceMetrics(activeProcesses: number) {
  const mem = process.memoryUsage();
  return {
    uptime: Math.floor((Date.now() - startTime) / 1000),
    platforms: { telegram: state.telegram, feishu: state.feishu },
    codex: {
      ...state.codex,
      avgDurationMs: state.codex.total
        ? Math.round(state.codex.totalDurationMs / state.codex.total)
        : 0,
    },
    copilot: {
      ...state.copilot,
      avgDurationMs: state.copilot.total
        ? Math.round(state.copilot.totalDurationMs / state.copilot.total)
        : 0,
    },
    memory: {
      rss: Math.round(mem.rss / 1024 / 1024),
      heap: Math.round(mem.heapUsed / 1024 / 1024),
    },
    activeProcesses,
  };
}
