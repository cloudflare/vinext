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
 * Dynamic API imports (headers(), cookies(), connection(), unstable_noStore())
 * are detected heuristically and classified as "ssr". Routes without explicit
 * config or detectable dynamic API usage are classified as "unknown" rather
 * than "static" to avoid false confidence.
 */

import fs from "node:fs";
import path from "node:path";
import type { Route } from "../routing/pages-router.js";
import type { AppRoute } from "../routing/app-router.js";
import type { PrerenderResult } from "./prerender.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type RouteType = "static" | "isr" | "ssr" | "unknown" | "api";

export type RouteRow = {
  pattern: string;
  type: RouteType;
  /** Only set for `isr` routes. */
  revalidate?: number;
  /**
   * True when the route was classified as `static` by speculative prerender
   * (i.e. was `unknown` from static analysis but rendered successfully).
   * Used by `formatBuildReport` to add a note in the legend.
   */
  prerendered?: boolean;
  /** Pre-render status from the prerender phase, if available. */
  prerenderStatus?: "rendered" | "skipped" | "error";
  /** For dynamic routes: the concrete URLs that were pre-rendered. */
  prerenderPaths?: string[];
};

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
    `^\\s*export\\s+const\\s+${name}\\s*(?::[^=]+)?\\s*=\\s*['"]([^'"]+)['"]`,
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
    `^\\s*export\\s+const\\s+${name}\\s*(?::[^=]+)?\\s*=\\s*(-?\\d+(?:\\.\\d+)?|Infinity)`,
    "m",
  );
  const m = re.exec(code);
  if (!m) return null;
  return m[1] === "Infinity" ? Infinity : parseFloat(m[1]);
}

// ─── Dynamic API detection (module-level compiled regexes) ───────────────────

// Anchored to line start (^) to avoid matching commented-out imports.
// Uses multiline flag so ^ matches each line in multi-line source.
// Negative lookbehind (?<!\btype\s) skips inline type modifiers like
// `import { type cookies }` which are erased at compile time.

/** Detects `import { headers | cookies | draftMode } from "next/headers"` */
const DYNAMIC_HEADERS_RE =
  /^\s*import\s*\{[^}]*(?<!\btype\s)\b(?:headers|cookies|draftMode)\b[^}]*\}\s*from\s*['"]next\/headers['"]/m;

/** Detects `import { connection } from "next/server"` (stabilized replacement for unstable_noStore) */
const DYNAMIC_SERVER_RE =
  /^\s*import\s*\{[^}]*(?<!\btype\s)\bconnection\b[^}]*\}\s*from\s*['"]next\/server['"]/m;

/** Detects `import { unstable_noStore | noStore } from "next/cache"` */
const DYNAMIC_CACHE_RE =
  /^\s*import\s*\{[^}]*(?<!\btype\s)\b(?:unstable_noStore|noStore)\b[^}]*\}\s*from\s*['"]next\/cache['"]/m;

/**
 * Detects imports of Next.js dynamic APIs that implicitly force a route dynamic.
 * Checks for:
 *   - import { headers, cookies, draftMode } from "next/headers"
 *   - import { connection } from "next/server"
 *   - import { unstable_noStore, noStore } from "next/cache"
 *
 * This is a heuristic — importing a function doesn't guarantee it's called
 * at render time (it could be conditionally used or in a non-render helper).
 * But it provides better signal than "unknown" for the build report.
 *
 * Limitations:
 *   - Does not detect `require()` or dynamic `import()` calls
 *   - Does not detect `type` imports (which are erased at runtime — correct behavior)
 *   - Anchored to line start to avoid false positives from commented-out imports
 */
export function detectsDynamicApiUsage(code: string): boolean {
  return (
    DYNAMIC_HEADERS_RE.test(code) || DYNAMIC_SERVER_RE.test(code) || DYNAMIC_CACHE_RE.test(code)
  );
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
  const returnObjects = extractGetStaticPropsReturnObjects(code);

  if (returnObjects) {
    for (const searchSpace of returnObjects) {
      const revalidate = extractTopLevelRevalidateValue(searchSpace);
      if (revalidate !== null) return revalidate;
    }
    return null;
  }

  const m = /\brevalidate\s*:\s*(-?\d+(?:\.\d+)?|Infinity|false)\b/.exec(code);
  if (!m) return null;
  if (m[1] === "false") return false;
  if (m[1] === "Infinity") return Infinity;
  return parseFloat(m[1]);
}

function extractTopLevelRevalidateValue(code: string): number | false | null {
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let quote: '"' | "'" | "`" | null = null;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < code.length; i++) {
    const char = code[i];
    const next = code[i + 1];

    if (inLineComment) {
      if (char === "\n") inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (quote) {
      if (char === "\\") {
        i++;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }

    if (char === "{") {
      braceDepth++;
      continue;
    }

    if (char === "}") {
      braceDepth--;
      continue;
    }

    if (char === "(") {
      parenDepth++;
      continue;
    }

    if (char === ")") {
      parenDepth--;
      continue;
    }

    if (char === "[") {
      bracketDepth++;
      continue;
    }

    if (char === "]") {
      bracketDepth--;
      continue;
    }

    if (
      braceDepth === 1 &&
      parenDepth === 0 &&
      bracketDepth === 0 &&
      matchesKeywordAt(code, i, "revalidate")
    ) {
      const colonIndex = findNextNonWhitespaceIndex(code, i + "revalidate".length);
      if (colonIndex === -1 || code[colonIndex] !== ":") continue;

      const valueStart = findNextNonWhitespaceIndex(code, colonIndex + 1);
      if (valueStart === -1) return null;

      const valueMatch = /^(-?\d+(?:\.\d+)?|Infinity|false)\b/.exec(code.slice(valueStart));
      if (!valueMatch) return null;
      if (valueMatch[1] === "false") return false;
      if (valueMatch[1] === "Infinity") return Infinity;
      return parseFloat(valueMatch[1]);
    }
  }

  return null;
}

function extractGetStaticPropsReturnObjects(code: string): string[] | null {
  const declarationMatch =
    /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+getStaticProps\b|(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+getStaticProps\b/.exec(
      code,
    );
  if (!declarationMatch) {
    // A file can re-export getStaticProps from another module without defining
    // it locally. In that case we can't safely infer revalidate from this file,
    // so skip the whole-file fallback to avoid unrelated false positives.
    if (/(?:^|\n)\s*export\s*\{[^}]*\bgetStaticProps\b[^}]*\}\s*from\b/.test(code)) {
      return [];
    }
    return null;
  }

  const declaration = extractGetStaticPropsDeclaration(code, declarationMatch);
  if (declaration === null) return [];

  const returnObjects = declaration.trimStart().startsWith("{")
    ? collectReturnObjectsFromFunctionBody(declaration)
    : [];

  if (returnObjects.length > 0) return returnObjects;

  const arrowMatch = declaration.search(/=>\s*\(\s*\{/);
  // getStaticProps was found but contains no return objects — return empty
  // (non-null signals the caller to skip the whole-file fallback).
  if (arrowMatch === -1) return [];

  const braceStart = declaration.indexOf("{", arrowMatch);
  if (braceStart === -1) return [];

  const braceEnd = findMatchingBrace(declaration, braceStart);
  if (braceEnd === -1) return [];

  return [declaration.slice(braceStart, braceEnd + 1)];
}

function extractGetStaticPropsDeclaration(
  code: string,
  declarationMatch: RegExpExecArray,
): string | null {
  const declarationStart = declarationMatch.index;
  const declarationText = declarationMatch[0];
  const declarationTail = code.slice(declarationStart);

  if (declarationText.includes("function getStaticProps")) {
    return extractFunctionBody(code, declarationStart + declarationText.length);
  }

  const functionExpressionMatch = /(?:async\s+)?function\b/.exec(declarationTail);
  if (functionExpressionMatch) {
    return extractFunctionBody(declarationTail, functionExpressionMatch.index);
  }

  const blockBodyMatch = /=>\s*\{/.exec(declarationTail);
  if (blockBodyMatch) {
    const braceStart = declarationTail.indexOf("{", blockBodyMatch.index);
    if (braceStart === -1) return null;

    const braceEnd = findMatchingBrace(declarationTail, braceStart);
    if (braceEnd === -1) return null;

    return declarationTail.slice(braceStart, braceEnd + 1);
  }

  const implicitArrowMatch = declarationTail.search(/=>\s*\(\s*\{/);
  if (implicitArrowMatch === -1) return null;

  const implicitBraceStart = declarationTail.indexOf("{", implicitArrowMatch);
  if (implicitBraceStart === -1) return null;

  const implicitBraceEnd = findMatchingBrace(declarationTail, implicitBraceStart);
  if (implicitBraceEnd === -1) return null;

  return declarationTail.slice(0, implicitBraceEnd + 1);
}

function extractFunctionBody(code: string, functionStart: number): string | null {
  const bodyEnd = findFunctionBodyEnd(code, functionStart);
  if (bodyEnd === -1) return null;

  const paramsStart = code.indexOf("(", functionStart);
  if (paramsStart === -1) return null;

  const paramsEnd = findMatchingParen(code, paramsStart);
  if (paramsEnd === -1) return null;

  const bodyStart = code.indexOf("{", paramsEnd + 1);
  if (bodyStart === -1) return null;

  return code.slice(bodyStart, bodyEnd + 1);
}

function collectReturnObjectsFromFunctionBody(code: string): string[] {
  const returnObjects: string[] = [];
  let quote: '"' | "'" | "`" | null = null;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < code.length; i++) {
    const char = code[i];
    const next = code[i + 1];

    if (inLineComment) {
      if (char === "\n") inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (quote) {
      if (char === "\\") {
        i++;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }

    if (matchesKeywordAt(code, i, "function")) {
      const nestedBodyEnd = findFunctionBodyEnd(code, i);
      if (nestedBodyEnd !== -1) {
        i = nestedBodyEnd;
      }
      continue;
    }

    if (matchesKeywordAt(code, i, "class")) {
      const classBodyEnd = findClassBodyEnd(code, i);
      if (classBodyEnd !== -1) {
        i = classBodyEnd;
      }
      continue;
    }

    if (char === "=" && next === ">") {
      const nestedBodyEnd = findArrowFunctionBodyEnd(code, i);
      if (nestedBodyEnd !== -1) {
        i = nestedBodyEnd;
      }
      continue;
    }

    if (
      (char >= "A" && char <= "Z") ||
      (char >= "a" && char <= "z") ||
      char === "_" ||
      char === "$" ||
      char === "*"
    ) {
      const methodBodyEnd = findObjectMethodBodyEnd(code, i);
      if (methodBodyEnd !== -1) {
        i = methodBodyEnd;
        continue;
      }
    }

    if (matchesKeywordAt(code, i, "return")) {
      const braceStart = findNextNonWhitespaceIndex(code, i + "return".length);
      if (braceStart === -1 || code[braceStart] !== "{") continue;

      const braceEnd = findMatchingBrace(code, braceStart);
      if (braceEnd === -1) continue;

      returnObjects.push(code.slice(braceStart, braceEnd + 1));
      i = braceEnd;
    }
  }

  return returnObjects;
}

function findFunctionBodyEnd(code: string, functionStart: number): number {
  const paramsStart = code.indexOf("(", functionStart);
  if (paramsStart === -1) return -1;

  const paramsEnd = findMatchingParen(code, paramsStart);
  if (paramsEnd === -1) return -1;

  const bodyStart = code.indexOf("{", paramsEnd + 1);
  if (bodyStart === -1) return -1;

  return findMatchingBrace(code, bodyStart);
}

function findClassBodyEnd(code: string, classStart: number): number {
  const bodyStart = code.indexOf("{", classStart + "class".length);
  if (bodyStart === -1) return -1;

  return findMatchingBrace(code, bodyStart);
}

function findArrowFunctionBodyEnd(code: string, arrowIndex: number): number {
  const bodyStart = findNextNonWhitespaceIndex(code, arrowIndex + 2);
  if (bodyStart === -1 || code[bodyStart] !== "{") return -1;

  return findMatchingBrace(code, bodyStart);
}

function findObjectMethodBodyEnd(code: string, start: number): number {
  let i = start;

  if (matchesKeywordAt(code, i, "async")) {
    const afterAsync = findNextNonWhitespaceIndex(code, i + "async".length);
    if (afterAsync === -1) return -1;
    if (code[afterAsync] !== "(") {
      i = afterAsync;
    }
  }

  if (code[i] === "*") {
    i = findNextNonWhitespaceIndex(code, i + 1);
    if (i === -1) return -1;
  }

  if (!/[A-Za-z_$]/.test(code[i] ?? "")) return -1;

  const nameStart = i;
  while (/[A-Za-z0-9_$]/.test(code[i] ?? "")) i++;
  const name = code.slice(nameStart, i);

  if (
    name === "if" ||
    name === "for" ||
    name === "while" ||
    name === "switch" ||
    name === "catch" ||
    name === "function" ||
    name === "return" ||
    name === "const" ||
    name === "let" ||
    name === "var" ||
    name === "new"
  ) {
    return -1;
  }

  if (name === "get" || name === "set") {
    const afterAccessor = findNextNonWhitespaceIndex(code, i);
    if (afterAccessor === -1) return -1;
    if (code[afterAccessor] !== "(") {
      i = afterAccessor;
      if (!/[A-Za-z_$]/.test(code[i] ?? "")) return -1;
      while (/[A-Za-z0-9_$]/.test(code[i] ?? "")) i++;
    }
  }

  const paramsStart = findNextNonWhitespaceIndex(code, i);
  if (paramsStart === -1 || code[paramsStart] !== "(") return -1;

  const paramsEnd = findMatchingParen(code, paramsStart);
  if (paramsEnd === -1) return -1;

  const bodyStart = findNextNonWhitespaceIndex(code, paramsEnd + 1);
  if (bodyStart === -1 || code[bodyStart] !== "{") return -1;

  return findMatchingBrace(code, bodyStart);
}

function findNextNonWhitespaceIndex(code: string, start: number): number {
  for (let i = start; i < code.length; i++) {
    if (!/\s/.test(code[i])) return i;
  }
  return -1;
}

function matchesKeywordAt(code: string, index: number, keyword: string): boolean {
  const before = index === 0 ? "" : code[index - 1];
  const after = code[index + keyword.length] ?? "";
  return (
    code.startsWith(keyword, index) &&
    (before === "" || !/[A-Za-z0-9_$]/.test(before)) &&
    (after === "" || !/[A-Za-z0-9_$]/.test(after))
  );
}

function findMatchingBrace(code: string, start: number): number {
  return findMatchingToken(code, start, "{", "}");
}

function findMatchingParen(code: string, start: number): number {
  return findMatchingToken(code, start, "(", ")");
}

function findMatchingToken(
  code: string,
  start: number,
  openToken: string,
  closeToken: string,
): number {
  let depth = 0;
  let quote: '"' | "'" | "`" | null = null;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = start; i < code.length; i++) {
    const char = code[i];
    const next = code[i + 1];

    if (inLineComment) {
      if (char === "\n") inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (quote) {
      if (char === "\\") {
        i++;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }

    if (char === openToken) {
      depth++;
      continue;
    }

    if (char === closeToken) {
      depth--;
      if (depth === 0) return i;
    }
  }

  return -1;
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

  // Check for imports of dynamic APIs — these strongly suggest the route is
  // dynamic even without explicit `export const dynamic` configuration.
  // This improves on "unknown" but remains a heuristic: the import could be
  // conditional or unused at render time.
  if (detectsDynamicApiUsage(code)) return { type: "ssr" };

  // No explicit config, no dynamic URL segments, and no detected dynamic API
  // imports — we can't confirm static without running the build.
  // Report as unknown rather than falsely claiming static.
  return { type: "unknown" };
}

// ─── Row building ─────────────────────────────────────────────────────────────

/**
 * Builds a sorted list of RouteRow objects from the discovered routes.
 * Routes are sorted alphabetically by path, matching filesystem order.
 *
 * When `prerenderResult` is provided, routes that were classified as `unknown`
 * by static analysis but were successfully rendered speculatively are upgraded
 * to `static` (confirmed by execution). The `prerendered` flag is set on those
 * rows so the formatter can add a legend note.
 */
export function buildReportRows(options: {
  pageRoutes?: Route[];
  apiRoutes?: Route[];
  appRoutes?: AppRoute[];
  prerenderResult?: PrerenderResult;
}): RouteRow[] {
  const rows: RouteRow[] = [];

  // Build maps from prerender results for route enrichment.
  const prerenderStatusMap = new Map<string, "rendered" | "skipped" | "error">();
  const prerenderPathsMap = new Map<string, string[]>();
  if (options.prerenderResult) {
    for (const r of options.prerenderResult.routes) {
      // For rendered routes with a concrete path (dynamic routes expanded to URLs),
      // collect all paths under the route pattern.
      if (r.status === "rendered") {
        prerenderStatusMap.set(r.route, "rendered");
        if (r.path) {
          const paths = prerenderPathsMap.get(r.route) ?? [];
          paths.push(r.path);
          prerenderPathsMap.set(r.route, paths);
        }
      } else if (!prerenderStatusMap.has(r.route)) {
        // Only set skipped/error if not already rendered (a dynamic route may
        // have some rendered paths and some errors).
        prerenderStatusMap.set(r.route, r.status);
      }
    }
  }

  for (const route of options.pageRoutes ?? []) {
    const { type, revalidate } = classifyPagesRoute(route.filePath);
    const prerenderStatus = prerenderStatusMap.get(route.pattern);
    const prerenderPaths = prerenderPathsMap.get(route.pattern);
    rows.push({ pattern: route.pattern, type, revalidate, prerenderStatus, prerenderPaths });
  }

  for (const route of options.apiRoutes ?? []) {
    rows.push({ pattern: route.pattern, type: "api" });
  }

  for (const route of options.appRoutes ?? []) {
    const { type, revalidate } = classifyAppRoute(route.pagePath, route.routePath, route.isDynamic);
    const prerenderStatus = prerenderStatusMap.get(route.pattern);
    const prerenderPaths = prerenderPathsMap.get(route.pattern);
    if (type === "unknown" && prerenderStatus === "rendered") {
      // Speculative prerender confirmed this route is static.
      rows.push({
        pattern: route.pattern,
        type: "static",
        prerendered: true,
        prerenderStatus,
        prerenderPaths,
      });
    } else {
      rows.push({ pattern: route.pattern, type, revalidate, prerenderStatus, prerenderPaths });
    }
  }

  // Sort purely by path — mirrors filesystem order, matching Next.js output style
  rows.sort((a, b) => a.pattern.localeCompare(b.pattern));

  return rows;
}

// ─── Formatting ───────────────────────────────────────────────────────────────

export const SYMBOLS: Record<RouteType, string> = {
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
    const corner = rows.length === 1 ? "─" : i === 0 ? "┌" : isLast ? "└" : "├";
    const sym = SYMBOLS[row.type];
    const suffix =
      row.type === "isr" && row.revalidate !== undefined ? `  (${row.revalidate}s)` : "";
    // Prerender annotation
    let prerenderSuffix = "";
    if (row.prerenderStatus === "rendered") {
      const pathCount = row.prerenderPaths?.length;
      prerenderSuffix = pathCount
        ? `  [prerendered: ${pathCount} path${pathCount !== 1 ? "s" : ""}]`
        : "  [prerendered]";
    } else if (row.prerenderStatus === "skipped") {
      prerenderSuffix = "  [skipped]";
    } else if (row.prerenderStatus === "error") {
      prerenderSuffix = "  [error]";
    }
    const padding = " ".repeat(maxPatternLen - row.pattern.length);
    lines.push(`  ${corner} ${sym} ${row.pattern}${padding}${suffix}${prerenderSuffix}`);
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
    lines.push("  ? Some routes could not be fully classified by static analysis. Routes that");
    lines.push("    import dynamic APIs (headers(), cookies(), etc.) are detected as dynamic,");
    lines.push("    but other dynamic patterns may not be caught without running the build.");
  }

  // Speculative-render note — shown when any routes were confirmed static by prerender
  const hasPrerendered = rows.some((r) => r.prerendered);
  if (hasPrerendered) {
    lines.push("");
    lines.push(
      "  ○ Routes marked static were confirmed by speculative prerender (attempted render",
    );
    lines.push("    succeeded without dynamic API usage).");
  }

  // Prerender summary — shown when any routes have prerender status
  const hasAnyPrerender = rows.some((r) => r.prerenderStatus);
  if (hasAnyPrerender) {
    const renderedCount = rows.filter((r) => r.prerenderStatus === "rendered").length;
    const skippedCount = rows.filter((r) => r.prerenderStatus === "skipped").length;
    const errorCount = rows.filter((r) => r.prerenderStatus === "error").length;
    lines.push("");
    const summaryParts: string[] = [];
    if (renderedCount > 0) summaryParts.push(`${renderedCount} prerendered`);
    if (skippedCount > 0) summaryParts.push(`${skippedCount} skipped`);
    if (errorCount > 0) summaryParts.push(`${errorCount} failed`);
    lines.push(`  Prerender: ${summaryParts.join(", ")}`);
  }

  return lines.join("\n");
}

// ─── Directory detection ──────────────────────────────────────────────────────

export function findDir(root: string, ...candidates: string[]): string | null {
  for (const candidate of candidates) {
    const full = path.join(root, candidate);
    try {
      if (fs.statSync(full).isDirectory()) return full;
    } catch {
      // not found or not a directory — try next candidate
    }
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
  pageExtensions: string[];
  prerenderResult?: PrerenderResult;
}): Promise<void> {
  const { root } = options;

  const appDir = findDir(root, "app", "src/app");
  const pagesDir = findDir(root, "pages", "src/pages");

  if (!appDir && !pagesDir) return;

  if (appDir) {
    // Dynamic import to avoid loading routing code unless needed
    const { appRouter } = await import("../routing/app-router.js");
    const routes = await appRouter(appDir, options.pageExtensions);
    const rows = buildReportRows({ appRoutes: routes, prerenderResult: options.prerenderResult });
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
    const rows = buildReportRows({
      pageRoutes,
      apiRoutes,
      prerenderResult: options.prerenderResult,
    });
    if (rows.length > 0) {
      console.log("\n" + formatBuildReport(rows, "pages"));
    }
  }
}
