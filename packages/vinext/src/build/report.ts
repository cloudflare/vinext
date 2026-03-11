/**
 * Build report — prints a Next.js-style route table after `vinext build`.
 *
 * Classifies every discovered route as:
 *   ○  Static   — confirmed static: force-static or revalidate=Infinity
 *   ◐  ISR      — statically rendered, revalidated on a timer (revalidate=N)
 *   ƒ  Dynamic  — confirmed dynamic: force-dynamic, revalidate=0, or getServerSideProps
 *   ?  Unknown  — no explicit config; likely dynamic but not confirmed
 *   λ  API      — API route handler
 *
 * Classification uses regex-based static source analysis (no module
 * execution). Vite's parseAst() is NOT used because it doesn't handle
 * TypeScript syntax.
 *
 * Limitation: without running the build, we cannot detect dynamic API usage
 * (headers(), cookies(), connection(), etc.) that implicitly forces a route
 * dynamic. Routes without explicit `export const dynamic` or
 * `export const revalidate` are classified as "unknown" rather than "static"
 * to avoid false confidence.
 */

import fs from "node:fs";
import path from "node:path";
import type { Route } from "../routing/pages-router.js";
import type { AppRoute } from "../routing/app-router.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type RouteType = "static" | "isr" | "ssr" | "unknown" | "api";

export interface RouteRow {
  pattern: string;
  type: RouteType;
  /** Only set for `isr` routes. */
  revalidate?: number;
}

// ─── Regex-based export detection ────────────────────────────────────────────

/**
 * Returns true if the source code contains a named export with the given name.
 * Handles all three common export forms:
 *   export function foo() {}
 *   export const foo = ...
 *   export { foo }
 */
export function hasNamedExport(code: string, name: string): boolean {
  // Function / generator / async function declaration
  const fnRe = new RegExp(`(?:^|\\n)\\s*export\\s+(?:async\\s+)?function\\s+${name}\\b`);
  if (fnRe.test(code)) return true;

  // Variable declaration (const / let / var)
  const varRe = new RegExp(`(?:^|\\n)\\s*export\\s+(?:const|let|var)\\s+${name}\\s*[=:]`);
  if (varRe.test(code)) return true;

  // Re-export specifier: export { foo } or export { foo as bar }
  const reRe = new RegExp(`export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`);
  if (reRe.test(code)) return true;

  return false;
}

/**
 * Extracts the string value of `export const <name> = "value"`.
 * Handles optional TypeScript type annotations:
 *   export const dynamic: string = "force-dynamic"
 * Returns null if the export is absent or not a string literal.
 */
export function extractExportConstString(code: string, name: string): string | null {
  const re = new RegExp(
    `(?:^|\\n)\\s*export\\s+const\\s+${name}\\s*(?::[^=]+)?\\s*=\\s*['"]([^'"]+)['"]`,
    "m",
  );
  const m = re.exec(code);
  return m ? m[1] : null;
}

/**
 * Extracts the numeric value of `export const <name> = <number>`.
 * Supports integers, decimals, negative values, and `Infinity`.
 * Handles optional TypeScript type annotations.
 * Returns null if the export is absent or not a number.
 */
export function extractExportConstNumber(code: string, name: string): number | null {
  const re = new RegExp(
    `(?:^|\\n)\\s*export\\s+const\\s+${name}\\s*(?::[^=]+)?\\s*=\\s*(-?\\d+(?:\\.\\d+)?|Infinity)`,
    "m",
  );
  const m = re.exec(code);
  if (!m) return null;
  return m[1] === "Infinity" ? Infinity : parseFloat(m[1]);
}

/**
 * Extracts the `revalidate` value from inside a `getStaticProps` return object.
 * Looks for:  revalidate: <number>  or  revalidate: false  or  revalidate: Infinity
 *
 * Returns:
 *   number   — a positive revalidation interval (enables ISR)
 *   0        — treat as SSR (revalidate every request)
 *   false    — fully static (no revalidation)
 *   Infinity — fully static (treated same as false by Next.js)
 *   null     — no `revalidate` key found (fully static)
 */
export function extractGetStaticPropsRevalidate(code: string): number | false | null {
  // TODO: This regex matches `revalidate:` anywhere in the file, not scoped to
  // the getStaticProps return object. A config object or comment elsewhere in
  // the file (e.g. `const defaults = { revalidate: 30 }`) could produce a false
  // positive. Rare in practice, but a proper AST-based approach would be more
  // accurate.
  const re = /\brevalidate\s*:\s*(-?\d+(?:\.\d+)?|Infinity|false)\b/;
  const m = re.exec(code);
  if (!m) return null;
  if (m[1] === "false") return false;
  if (m[1] === "Infinity") return Infinity;
  return parseFloat(m[1]);
}

// ─── Route classification ─────────────────────────────────────────────────────

/**
 * Classifies a Pages Router page file by reading its source and examining
 * which data-fetching exports it contains.
 *
 * API routes (files under pages/api/) are always `api`.
 */
export function classifyPagesRoute(filePath: string): {
  type: RouteType;
  revalidate?: number;
} {
  // API routes are identified by their path
  const normalized = filePath.replace(/\\/g, "/");
  if (normalized.includes("/pages/api/")) {
    return { type: "api" };
  }

  let code: string;
  try {
    code = fs.readFileSync(filePath, "utf8");
  } catch {
    return { type: "unknown" };
  }

  if (hasNamedExport(code, "getServerSideProps")) {
    return { type: "ssr" };
  }

  if (hasNamedExport(code, "getStaticProps")) {
    const revalidate = extractGetStaticPropsRevalidate(code);

    if (revalidate === null || revalidate === false || revalidate === Infinity) {
      return { type: "static" };
    }
    if (revalidate === 0) {
      return { type: "ssr" };
    }
    // Positive number → ISR
    return { type: "isr", revalidate };
  }

  return { type: "static" };
}

/**
 * Classifies an App Router route.
 *
 * @param pagePath   Absolute path to the page.tsx (null for API-only routes)
 * @param routePath  Absolute path to the route.ts handler (null for page routes)
 * @param isDynamic  Whether the URL pattern contains dynamic segments
 */
export function classifyAppRoute(
  pagePath: string | null,
  routePath: string | null,
  isDynamic: boolean,
): { type: RouteType; revalidate?: number } {
  // Route handlers with no page component → API
  if (routePath !== null && pagePath === null) {
    return { type: "api" };
  }

  const filePath = pagePath ?? routePath;
  if (!filePath) return { type: "unknown" };

  let code: string;
  try {
    code = fs.readFileSync(filePath, "utf8");
  } catch {
    return { type: "unknown" };
  }

  // Check `export const dynamic`
  const dynamicValue = extractExportConstString(code, "dynamic");
  if (dynamicValue === "force-dynamic") {
    return { type: "ssr" };
  }
  if (dynamicValue === "force-static" || dynamicValue === "error") {
    // "error" enforces static rendering — it throws if dynamic APIs are used,
    // so the page is statically rendered (same as force-static for classification).
    return { type: "static" };
  }

  // Check `export const revalidate`
  const revalidateValue = extractExportConstNumber(code, "revalidate");
  if (revalidateValue !== null) {
    if (revalidateValue === Infinity) return { type: "static" };
    if (revalidateValue === 0) return { type: "ssr" };
    if (revalidateValue > 0) return { type: "isr", revalidate: revalidateValue };
  }

  // Fall back to isDynamic flag (dynamic URL segments without explicit config)
  if (isDynamic) return { type: "ssr" };

  // No explicit config and no dynamic URL segments — we can't confirm static
  // without running the build (dynamic API calls like headers() are invisible
  // to static analysis). Report as unknown rather than falsely claiming static.
  return { type: "unknown" };
}

// ─── Row building ─────────────────────────────────────────────────────────────

/**
 * Builds a sorted list of RouteRow objects from the discovered routes.
 * Routes are sorted alphabetically by path, matching filesystem order.
 */
export function buildReportRows(options: {
  pageRoutes?: Route[];
  apiRoutes?: Route[];
  appRoutes?: AppRoute[];
}): RouteRow[] {
  const rows: RouteRow[] = [];

  for (const route of options.pageRoutes ?? []) {
    const { type, revalidate } = classifyPagesRoute(route.filePath);
    rows.push({ pattern: route.pattern, type, revalidate });
  }

  for (const route of options.apiRoutes ?? []) {
    rows.push({ pattern: route.pattern, type: "api" });
  }

  for (const route of options.appRoutes ?? []) {
    const { type, revalidate } = classifyAppRoute(route.pagePath, route.routePath, route.isDynamic);
    rows.push({ pattern: route.pattern, type, revalidate });
  }

  // Sort purely by path — mirrors filesystem order, matching Next.js output style
  rows.sort((a, b) => a.pattern.localeCompare(b.pattern));

  return rows;
}

// ─── Formatting ───────────────────────────────────────────────────────────────

const SYMBOLS: Record<RouteType, string> = {
  static: "○",
  isr: "◐",
  ssr: "ƒ",
  unknown: "?",
  api: "λ",
};

const LABELS: Record<RouteType, string> = {
  static: "Static",
  isr: "ISR",
  ssr: "Dynamic",
  unknown: "Unknown",
  api: "API",
};

/**
 * Formats a list of RouteRows into a Next.js-style build report string.
 *
 * Example output:
 *   Route (pages)
 *   ┌ ○ /
 *   ├ ◐ /blog/:slug  (60s)
 *   ├ ƒ /dashboard
 *   └ λ /api/posts
 *
 *   ○ Static  ◐ ISR  ƒ Dynamic  λ API
 */
export function formatBuildReport(rows: RouteRow[], routerLabel = "app"): string {
  if (rows.length === 0) return "";

  const lines: string[] = [];
  lines.push(`  Route (${routerLabel})`);

  // Determine padding width from the longest pattern
  const maxPatternLen = Math.max(...rows.map((r) => r.pattern.length));

  rows.forEach((row, i) => {
    const isLast = i === rows.length - 1;
    const corner = i === 0 ? "┌" : isLast ? "└" : "├";
    const sym = SYMBOLS[row.type];
    const suffix =
      row.type === "isr" && row.revalidate !== undefined ? `  (${row.revalidate}s)` : "";
    const padding = " ".repeat(maxPatternLen - row.pattern.length);
    lines.push(`  ${corner} ${sym} ${row.pattern}${padding}${suffix}`);
  });

  lines.push("");

  // Legend — only include types that appear in this report, sorted alphabetically by label
  const usedTypes = [...new Set(rows.map((r) => r.type))].sort((a, b) =>
    LABELS[a].localeCompare(LABELS[b]),
  );
  lines.push("  " + usedTypes.map((t) => `${SYMBOLS[t]} ${LABELS[t]}`).join("  "));

  // Explanatory note — only shown when unknown routes are present
  if (usedTypes.includes("unknown")) {
    lines.push("");
    lines.push("  ? Some routes could not be classified. vinext currently uses static analysis");
    lines.push(
      "    and cannot detect dynamic API usage (headers(), cookies(), etc.) at build time.",
    );
    lines.push("    Automatic classification will be improved in a future release.");
  }

  return lines.join("\n");
}

// ─── Directory detection ──────────────────────────────────────────────────────

function findDir(root: string, ...candidates: string[]): string | null {
  for (const candidate of candidates) {
    const full = path.join(root, candidate);
    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) return full;
  }
  return null;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Scans the project at `root`, classifies all routes, and prints the
 * Next.js-style build report to stdout.
 *
 * Called at the end of `vinext build` in cli.ts.
 */
export async function printBuildReport(options: {
  root: string;
  pageExtensions?: string[];
}): Promise<void> {
  const { root } = options;

  const appDir = findDir(root, "app", "src/app");
  const pagesDir = findDir(root, "pages", "src/pages");

  if (!appDir && !pagesDir) return;

  if (appDir) {
    // Dynamic import to avoid loading routing code unless needed
    const { appRouter } = await import("../routing/app-router.js");
    const routes = await appRouter(appDir, options.pageExtensions);
    const rows = buildReportRows({ appRoutes: routes });
    if (rows.length > 0) {
      console.log("\n" + formatBuildReport(rows, "app"));
    }
  }

  if (pagesDir) {
    const { pagesRouter, apiRouter } = await import("../routing/pages-router.js");
    const [pageRoutes, apiRoutes] = await Promise.all([
      pagesRouter(pagesDir, options.pageExtensions),
      apiRouter(pagesDir, options.pageExtensions),
    ]);
    const rows = buildReportRows({ pageRoutes, apiRoutes });
    if (rows.length > 0) {
      console.log("\n" + formatBuildReport(rows, "pages"));
    }
  }
}
