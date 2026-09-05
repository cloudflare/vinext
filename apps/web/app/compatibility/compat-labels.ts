/**
 * Shared vocabulary for the compatibility views.
 *
 * These live in a plain module rather than in contribution-grid.tsx because
 * that file is a client component: importing values from it into the server
 * component turns them into client-reference proxies that throw when called.
 * The server-rendered results table in page.tsx needs the same labels the grid
 * uses, so they belong on this side of the boundary.
 */
import type { FileStatus, RouterKind } from "@/app/lib/db/schema";
import { VITE_EQUIVALENT_LABEL, type SuiteSupportStatus } from "./suite-support";

export type GridCell = {
  suite: string;
  status: FileStatus;
  router: RouterKind;
  supportStatus: SuiteSupportStatus;
  feature: string | null;
  reason: string | null;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
};

export type DisplayStatus = FileStatus | Exclude<SuiteSupportStatus, "supported">;

export const LABELS: Record<DisplayStatus, string> = {
  pass: "Pass",
  partial: "Partial",
  fail: "Fail",
  skip: "Skipped by Next.js",
  deferred: "Deferred",
  "needs-vite-equivalent": VITE_EQUIVALENT_LABEL,
  unsupported: "Unsupported by vinext",
};

export const SUPPORT_LABELS: Record<SuiteSupportStatus, string> = {
  supported: "Supported",
  deferred: "Deferred",
  "needs-vite-equivalent": VITE_EQUIVALENT_LABEL,
  unsupported: "Unsupported by vinext",
};

export const ROUTER_LABELS: Record<RouterKind, string> = {
  app: "App Router",
  pages: "Pages Router",
  both: "Mixed (App + Pages)",
  unknown: "No router fixture",
};

/**
 * The compatibility-scope classification wins over the raw test result, so a
 * deliberately deferred suite does not read as a failure.
 */
export function getDisplayStatus(cell: GridCell): DisplayStatus {
  return cell.supportStatus === "supported" ? cell.status : cell.supportStatus;
}

/**
 * Groups a test file by the part of the Next.js suite it belongs to:
 *
 *   test/e2e/app-dir/foo.test.ts        → "app-dir"
 *   test/e2e/middleware/foo.test.ts     → "middleware"
 *   test/e2e/foo.test.ts                → "e2e"
 *   test/integration/foo.test.ts        → "integration"
 *   test/unit/foo.test.ts               → "unit"
 *
 * Returns null when the path has been collapsed to a basename (older reports
 * that don't preserve path info) — the caller hides the row.
 */
export function deriveSuiteGroup(suite: string): string | null {
  if (!suite.includes("/")) return null;
  const parts = suite.split("/").filter(Boolean);
  // Strip a leading "test/" if present.
  const start = parts[0] === "test" ? 1 : 0;
  const first = parts[start];
  if (!first) return null;
  // For test/e2e/<group>/file or test/integration/<group>/file, use the
  // sub-group when there is one beyond the leaf file. Otherwise fall back
  // to the top-level directory (e.g. "e2e", "integration").
  if (parts.length - start >= 3) return parts[start + 1];
  return first;
}

export function summarize(cell: GridCell): string {
  const parts = [`${cell.passed}/${cell.total} passed`];
  if (cell.failed > 0) parts.push(`${cell.failed} failed`);
  if (cell.skipped > 0) parts.push(`${cell.skipped} skipped`);
  const group = deriveSuiteGroup(cell.suite);
  const prefix = group ? `[${group}] ${cell.suite}` : cell.suite;
  const routerTag = ROUTER_LABELS[cell.router];
  const displayStatus = getDisplayStatus(cell);
  const rawStatus = displayStatus === cell.status ? "" : ` · raw result: ${LABELS[cell.status]}`;
  return `${prefix} — ${LABELS[displayStatus]}${rawStatus} · ${routerTag} (${parts.join(", ")})`;
}

/** Groups a cell for the results table: its feature label, else its suite group. */
export function groupKey(cell: GridCell): string {
  return cell.feature ?? deriveSuiteGroup(cell.suite) ?? "Other";
}
