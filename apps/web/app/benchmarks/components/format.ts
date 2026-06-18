/** Shared formatting and comparison helpers for the benchmarks dashboard. */

export function formatMs(ms: number | null): string {
  if (ms === null) return "-";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function formatBytes(b: number | null): string {
  if (b === null) return "-";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(2)} MB`;
}

export const RUNNER_COLORS: Record<string, string> = {
  nextjs: "var(--color-chart-nextjs, #f97316)",
  vinext: "var(--color-chart-vinext, #3b82f6)",
};
