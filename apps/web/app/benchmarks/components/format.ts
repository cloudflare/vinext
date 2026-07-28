/** Shared formatting and comparison helpers for the benchmarks dashboard. */

// These render during SSR on Workers and again in the browser. Pin locale and
// timezone so both passes produce identical text; Date.toLocaleString() uses
// the runtime's locale/timezone and causes hydration mismatches.
const UTC_DATE_TIME = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});
const UTC_DATE = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });

// Non-breaking spaces keep each formatted value/date atomic. Table cells and
// headers were line-breaking inside values ("128.5<br>KB", split dates);
// surrounding text still wraps at the separators around these tokens.
const NBSP = " ";

export function formatUtcDateTime(iso: string): string {
  return `${UTC_DATE_TIME.format(new Date(iso))} UTC`.replaceAll(" ", NBSP);
}

export function formatUtcDate(iso: string): string {
  return UTC_DATE.format(new Date(iso)).replaceAll(" ", NBSP);
}

export function formatMs(ms: number | null): string {
  if (ms === null) return "-";
  if (ms < 1000) return `${Math.round(ms)}${NBSP}ms`;
  return `${(ms / 1000).toFixed(2)}${NBSP}s`;
}

export function formatBytes(b: number | null): string {
  if (b === null) return "-";
  if (b < 1024) return `${b}${NBSP}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}${NBSP}KB`;
  return `${(b / (1024 * 1024)).toFixed(2)}${NBSP}MB`;
}

export const RUNNER_COLORS: Record<string, string> = {
  nextjs: "var(--color-chart-nextjs, #4a5261)",
  vinext: "var(--color-chart-vinext, #f6821f)",
};
