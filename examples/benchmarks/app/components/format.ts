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

/**
 * Compare a value against a baseline where lower is better (times, sizes).
 * Returns e.g. "2.1x faster", "1.3x slower", or null if inputs are invalid.
 */
export function speedup(
  baseline: number | null,
  value: number | null,
): string | null {
  if (baseline === null || value === null || baseline === 0 || value === 0) return null;
  const ratio = baseline / value;
  if (ratio > 1) return `${ratio.toFixed(1)}x faster`;
  if (ratio < 1) return `${(1 / ratio).toFixed(1)}x slower`;
  return null;
}

/**
 * Compare a size value against a baseline.
 * Returns e.g. "56% smaller", "12% larger", or null if inputs are invalid.
 */
export function sizeReduction(
  baseline: number | null,
  value: number | null,
): string | null {
  if (baseline === null || value === null || baseline === 0) return null;
  const pct = Math.round((1 - value / baseline) * 100);
  if (pct > 0) return `${pct}% smaller`;
  if (pct < 0) return `${Math.abs(pct)}% larger`;
  return null;
}

/** True when the comparison string indicates an improvement. */
export function isImprovement(label: string | null): boolean {
  if (!label) return false;
  return label.includes("faster") || label.includes("smaller");
}

export const RUNNER_LABELS: Record<string, string> = {
  nextjs: "Next.js 16 (Turbopack)",
  vinext: "vinext (Vite 7 / Rollup)",
  vinext_rolldown: "vinext (Vite 8 / Rolldown)",
};

export const RUNNER_COLORS: Record<string, string> = {
  nextjs: "var(--color-chart-nextjs, #f97316)",
  vinext: "var(--color-chart-vinext, #3b82f6)",
  vinext_rolldown: "var(--color-chart-rolldown, #8b5cf6)",
};
