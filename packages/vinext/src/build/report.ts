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
 * Classification uses AST-based static source analysis (no module execution)
 * via the TypeScript compiler API. Vite's parseAst() is not used because it
 * doesn't handle TypeScript syntax.
 *
 * Limitation: without running the build, we cannot detect dynamic API usage
 * (headers(), cookies(), connection(), etc.) that implicitly forces a route
 * dynamic. Routes without explicit `export const dynamic` or
 * `export const revalidate` are classified as "unknown" rather than "static"
 * to avoid false confidence.
 */

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { Route } from "../routing/pages-router.js";
import type { AppRoute } from "../routing/app-router.js";
import type { PrerenderResult } from "./prerender.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type RouteType = "static" | "isr" | "ssr" | "unknown" | "api";

export interface RouteRow {
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
}

// ─── AST-based export detection ──────────────────────────────────────────────

type ResolvedExport =
  | {
      kind: "local";
      localName: string;
    }
  | {
      kind: "reexport";
    };

interface ModuleAnalysis {
  sourceFile: ts.SourceFile;
  localBindings: Map<string, ts.Declaration>;
  exports: Map<string, ResolvedExport>;
}

interface ParsedSourceCandidate {
  sourceFile: ts.SourceFile;
  diagnosticCount: number;
  scriptKind: ts.ScriptKind;
}

type ResolvedFunctionLike = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;

type GetStaticPropsResolution =
  | {
      kind: "absent";
    }
  | {
      kind: "reexport";
    }
  | {
      kind: "function";
      fn: ResolvedFunctionLike;
    }
  | {
      kind: "unresolved";
    };

/**
 * Returns true if the source code contains a named export with the given name.
 * Handles all three common export forms:
 *   export function foo() {}
 *   export const foo = ...
 *   export { foo }
 */
export function hasNamedExport(code: string, name: string, filePath?: string): boolean {
  return hasNamedExportFromAnalysis(getModuleAnalysis(code, filePath), name);
}

/**
 * Extracts the string value of `export const <name> = "value"`.
 * Handles optional TypeScript type annotations:
 *   export const dynamic: string = "force-dynamic"
 * Returns null if the export is absent or not a string literal.
 */
export function extractExportConstString(
  code: string,
  name: string,
  filePath?: string,
): string | null {
  return extractExportConstStringFromAnalysis(getModuleAnalysis(code, filePath), name);
}

function extractExportConstStringFromAnalysis(
  analysis: ModuleAnalysis,
  name: string,
): string | null {
  const initializer = resolveExportedConstExpression(analysis, name);
  if (!initializer) return null;

  if (ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer)) {
    return initializer.text;
  }

  return null;
}

/**
 * Extracts the numeric value of `export const <name> = <number>`.
 * Supports integers, decimals, negative values, and `Infinity`.
 * Handles optional TypeScript type annotations.
 * Returns null if the export is absent or not a number.
 */
export function extractExportConstNumber(
  code: string,
  name: string,
  filePath?: string,
): number | null {
  return extractExportConstNumberFromAnalysis(getModuleAnalysis(code, filePath), name);
}

function extractExportConstNumberFromAnalysis(
  analysis: ModuleAnalysis,
  name: string,
): number | null {
  return extractNumericLiteralValue(resolveExportedConstExpression(analysis, name) ?? undefined);
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
 *   null     — no local `revalidate` key found, or it could not be inferred
 */
export function extractGetStaticPropsRevalidate(
  code: string,
  filePath?: string,
): number | false | null {
  return extractGetStaticPropsRevalidateFromAnalysis(getModuleAnalysis(code, filePath));
}

function hasNamedExportFromAnalysis(analysis: ModuleAnalysis, name: string): boolean {
  return analysis.exports.has(name);
}

function extractGetStaticPropsRevalidateFromAnalysis(
  analysis: ModuleAnalysis,
): number | false | null {
  const getStaticProps = resolveGetStaticProps(analysis);

  if (getStaticProps.kind === "absent") {
    for (const returnObject of collectTopLevelReturnObjectLiterals(analysis.sourceFile)) {
      const revalidate = extractObjectLiteralRevalidate(returnObject);
      if (revalidate !== null) return revalidate;
    }
    return null;
  }

  if (getStaticProps.kind !== "function") {
    return null;
  }

  for (const returnObject of collectReturnObjectsFromFunctionLike(getStaticProps.fn)) {
    const revalidate = extractObjectLiteralRevalidate(returnObject);
    if (revalidate !== null) return revalidate;
  }

  return null;
}

function getModuleAnalysis(code: string, filePath?: string): ModuleAnalysis {
  const sourceFile = filePath
    ? createSourceFileForPath(code, filePath)
    : createBestSourceFile(code);

  const localBindings = new Map<string, ts.Declaration>();
  const exports = new Map<string, ResolvedExport>();

  for (const statement of sourceFile.statements) {
    collectLocalBindings(statement, localBindings);
  }

  for (const statement of sourceFile.statements) {
    collectExports(statement, exports, localBindings);
  }

  return { sourceFile, localBindings, exports };
}

function createBestSourceFile(code: string): ts.SourceFile {
  const preferredKind = ts.ScriptKind.TSX;
  const candidates = [
    createSourceFileForKind(code, ts.ScriptKind.TS),
    createSourceFileForKind(code, ts.ScriptKind.TSX),
  ];

  let best = candidates[0];

  for (const candidate of candidates.slice(1)) {
    if (candidate.diagnosticCount < best.diagnosticCount) {
      best = candidate;
      continue;
    }

    if (
      candidate.diagnosticCount === best.diagnosticCount &&
      candidate.scriptKind === preferredKind &&
      best.scriptKind !== preferredKind
    ) {
      best = candidate;
    }
  }

  return best.sourceFile;
}

function createSourceFileForPath(code: string, filePath: string): ts.SourceFile {
  const scriptKind = getScriptKindFromFilePath(filePath);
  if (scriptKind === null) {
    return createBestSourceFile(code);
  }

  return createSourceFileForKind(code, scriptKind, filePath).sourceFile;
}

function createSourceFileForKind(
  code: string,
  scriptKind: ts.ScriptKind,
  fileName = getSyntheticFileName(scriptKind),
): ParsedSourceCandidate {
  const sourceFile = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, scriptKind);
  return {
    sourceFile,
    diagnosticCount: getParseDiagnosticCount(sourceFile),
    scriptKind,
  };
}

function getSyntheticFileName(scriptKind: ts.ScriptKind): string {
  switch (scriptKind) {
    case ts.ScriptKind.TS:
      return "report-analysis.ts";
    case ts.ScriptKind.TSX:
      return "report-analysis.tsx";
    case ts.ScriptKind.JS:
      return "report-analysis.js";
    case ts.ScriptKind.JSX:
      return "report-analysis.jsx";
    default:
      return "report-analysis.tsx";
  }
}

function getScriptKindFromFilePath(filePath: string): ts.ScriptKind | null {
  switch (path.extname(filePath).toLowerCase()) {
    case ".ts":
    case ".mts":
    case ".cts":
      return ts.ScriptKind.TS;
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS;
    case ".jsx":
      return ts.ScriptKind.JSX;
    default:
      return null;
  }
}

function getParseDiagnosticCount(sourceFile: ts.SourceFile): number {
  return (
    (sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.DiagnosticWithLocation[] })
      .parseDiagnostics?.length ?? 0
  );
}

function collectLocalBindings(
  statement: ts.Statement,
  localBindings: Map<string, ts.Declaration>,
): void {
  if (ts.isFunctionDeclaration(statement) && statement.name) {
    localBindings.set(statement.name.text, statement);
    return;
  }

  if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) {
        localBindings.set(declaration.name.text, declaration);
      }
    }
  }
}

function collectExports(
  statement: ts.Statement,
  exports: Map<string, ResolvedExport>,
  localBindings: Map<string, ts.Declaration>,
): void {
  if (ts.isFunctionDeclaration(statement) && statement.name && hasNamedExportModifier(statement)) {
    exports.set(statement.name.text, { kind: "local", localName: statement.name.text });
    return;
  }

  if (ts.isVariableStatement(statement) && hasNamedExportModifier(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) {
        exports.set(declaration.name.text, { kind: "local", localName: declaration.name.text });
      }
    }
  }

  if (!ts.isExportDeclaration(statement) || !statement.exportClause) {
    return;
  }

  if (statement.isTypeOnly) {
    return;
  }

  if (!ts.isNamedExports(statement.exportClause)) {
    return;
  }

  for (const specifier of statement.exportClause.elements) {
    if (specifier.isTypeOnly) {
      continue;
    }

    const exportName = specifier.name.text;
    if (statement.moduleSpecifier) {
      exports.set(exportName, { kind: "reexport" });
      continue;
    }

    const localName = specifier.propertyName?.text ?? exportName;
    exports.set(
      exportName,
      localBindings.has(localName) ? { kind: "local", localName } : { kind: "reexport" },
    );
  }
}

function hasNamedExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;

  const modifiers = ts.getModifiers(node) ?? [];
  const hasExport = modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
  const hasDefault = modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
  const hasDeclare = modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword);

  return hasExport && !hasDefault && !hasDeclare;
}

function resolveExportedConstExpression(
  analysis: ModuleAnalysis,
  exportName: string,
): ts.Expression | null {
  const resolved = analysis.exports.get(exportName);
  if (!resolved || resolved.kind !== "local") return null;

  return resolveLocalConstExpression(analysis, resolved.localName);
}

function resolveLocalConstExpression(
  analysis: ModuleAnalysis,
  localName: string,
  seen = new Set<string>(),
): ts.Expression | null {
  if (seen.has(localName)) return null;
  seen.add(localName);

  const declaration = analysis.localBindings.get(localName);
  if (!declaration || !ts.isVariableDeclaration(declaration)) return null;

  const declarationList = declaration.parent;
  if (!ts.isVariableDeclarationList(declarationList)) return null;
  if ((declarationList.flags & ts.NodeFlags.Const) === 0) return null;

  const initializer = unwrapExpression(declaration.initializer);
  if (!initializer) return null;
  if (ts.isIdentifier(initializer)) {
    const resolvedInitializer = resolveLocalConstExpression(analysis, initializer.text, seen);
    return resolvedInitializer ?? initializer;
  }

  return initializer;
}

function resolveGetStaticProps(analysis: ModuleAnalysis): GetStaticPropsResolution {
  const exportedBinding = analysis.exports.get("getStaticProps");
  if (!exportedBinding) return { kind: "absent" };
  if (exportedBinding.kind === "reexport") return { kind: "reexport" };

  const fn = resolveLocalFunctionLike(analysis, exportedBinding.localName);
  if (!fn) return { kind: "unresolved" };

  return { kind: "function", fn };
}

function resolveLocalFunctionLike(
  analysis: ModuleAnalysis,
  localName: string,
  seen = new Set<string>(),
): ResolvedFunctionLike | null {
  if (seen.has(localName)) return null;
  seen.add(localName);

  const declaration = analysis.localBindings.get(localName);

  if (declaration && ts.isFunctionDeclaration(declaration)) {
    return declaration;
  }

  if (!declaration || !ts.isVariableDeclaration(declaration)) {
    return null;
  }

  const initializer = unwrapExpression(declaration.initializer);
  if (!initializer) return null;

  if (ts.isFunctionExpression(initializer) || ts.isArrowFunction(initializer)) {
    return initializer;
  }

  if (ts.isIdentifier(initializer)) {
    return resolveLocalFunctionLike(analysis, initializer.text, seen);
  }

  return null;
}

function unwrapExpression(expression: ts.Expression | undefined): ts.Expression | undefined {
  let current = expression;

  while (current) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }

    if (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)) {
      current = current.expression;
      continue;
    }

    if (ts.isSatisfiesExpression(current)) {
      current = current.expression;
      continue;
    }

    if (ts.isNonNullExpression(current)) {
      current = current.expression;
      continue;
    }

    break;
  }

  return current;
}

function collectReturnObjectsFromFunctionLike(
  fn: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction,
): ts.ObjectLiteralExpression[] {
  if (!fn.body) return [];

  if (!ts.isBlock(fn.body)) {
    const body = unwrapExpression(fn.body);
    if (body && ts.isObjectLiteralExpression(body)) {
      return [body];
    }
    return [];
  }

  return collectTopLevelReturnObjectLiterals(fn.body);
}

function collectTopLevelReturnObjectLiterals(
  container: ts.Block | ts.SourceFile,
): ts.ObjectLiteralExpression[] {
  const returnObjects: ts.ObjectLiteralExpression[] = [];

  const visitStatement = (statement: ts.Statement): void => {
    if (ts.isReturnStatement(statement)) {
      const expression = unwrapExpression(statement.expression);
      if (expression && ts.isObjectLiteralExpression(expression)) {
        returnObjects.push(expression);
      }
      return;
    }

    if (ts.isBlock(statement)) {
      for (const child of statement.statements) visitStatement(child);
      return;
    }

    if (ts.isIfStatement(statement)) {
      visitStatement(statement.thenStatement);
      if (statement.elseStatement) visitStatement(statement.elseStatement);
      return;
    }

    if (
      ts.isForStatement(statement) ||
      ts.isForInStatement(statement) ||
      ts.isForOfStatement(statement) ||
      ts.isWhileStatement(statement) ||
      ts.isDoStatement(statement) ||
      ts.isLabeledStatement(statement) ||
      ts.isWithStatement(statement)
    ) {
      visitStatement(statement.statement);
      return;
    }

    if (ts.isSwitchStatement(statement)) {
      for (const clause of statement.caseBlock.clauses) {
        for (const child of clause.statements) visitStatement(child);
      }
      return;
    }

    if (ts.isTryStatement(statement)) {
      visitStatement(statement.tryBlock);
      if (statement.catchClause) visitStatement(statement.catchClause.block);
      if (statement.finallyBlock) visitStatement(statement.finallyBlock);
    }
  };

  for (const statement of container.statements) {
    visitStatement(statement);
  }

  return returnObjects;
}

function extractObjectLiteralRevalidate(node: ts.ObjectLiteralExpression): number | false | null {
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    if (getPropertyNameText(property.name) !== "revalidate") continue;

    const value = extractLiteralRevalidateValue(property.initializer);
    if (value !== null) return value;
    return null;
  }

  return null;
}

function getPropertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }

  return null;
}

function extractLiteralRevalidateValue(expression: ts.Expression): number | false | null {
  const initializer = unwrapExpression(expression);
  if (!initializer) return null;

  if (initializer.kind === ts.SyntaxKind.FalseKeyword) {
    return false;
  }

  return extractNumericLiteralValue(initializer);
}

function extractNumericLiteralValue(expression: ts.Expression | undefined): number | null {
  const initializer = unwrapExpression(expression);
  if (!initializer) return null;

  if (ts.isNumericLiteral(initializer)) {
    return Number(initializer.text);
  }

  if (
    ts.isPrefixUnaryExpression(initializer) &&
    initializer.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(initializer.operand)
  ) {
    return -Number(initializer.operand.text);
  }

  if (ts.isIdentifier(initializer) && initializer.text === "Infinity") {
    return Infinity;
  }

  return null;
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

  const analysis = getModuleAnalysis(code, filePath);

  if (hasNamedExportFromAnalysis(analysis, "getServerSideProps")) {
    return { type: "ssr" };
  }

  if (hasNamedExportFromAnalysis(analysis, "getStaticProps")) {
    const getStaticProps = resolveGetStaticProps(analysis);
    if (getStaticProps.kind === "reexport" || getStaticProps.kind === "unresolved") {
      return { type: "unknown" };
    }

    const revalidate = extractGetStaticPropsRevalidateFromAnalysis(analysis);

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

  const analysis = getModuleAnalysis(code, filePath);

  // Check `export const dynamic`
  const dynamicValue = extractExportConstStringFromAnalysis(analysis, "dynamic");
  if (dynamicValue === "force-dynamic") {
    return { type: "ssr" };
  }
  if (dynamicValue === "force-static" || dynamicValue === "error") {
    // "error" enforces static rendering — it throws if dynamic APIs are used,
    // so the page is statically rendered (same as force-static for classification).
    return { type: "static" };
  }

  // Check `export const revalidate`
  const revalidateValue = extractExportConstNumberFromAnalysis(analysis, "revalidate");
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

  // Build a set of routes that were confirmed rendered by speculative prerender.
  const renderedRoutes = new Set<string>();
  if (options.prerenderResult) {
    for (const r of options.prerenderResult.routes) {
      if (r.status === "rendered") renderedRoutes.add(r.route);
    }
  }

  for (const route of options.pageRoutes ?? []) {
    const { type, revalidate } = classifyPagesRoute(route.filePath);
    if (type === "unknown" && renderedRoutes.has(route.pattern)) {
      // Speculative prerender confirmed this route is static.
      rows.push({ pattern: route.pattern, type: "static", prerendered: true });
    } else {
      rows.push({ pattern: route.pattern, type, revalidate });
    }
  }

  for (const route of options.apiRoutes ?? []) {
    rows.push({ pattern: route.pattern, type: "api" });
  }

  for (const route of options.appRoutes ?? []) {
    const { type, revalidate } = classifyAppRoute(route.pagePath, route.routePath, route.isDynamic);
    if (type === "unknown" && renderedRoutes.has(route.pattern)) {
      // Speculative prerender confirmed this route is static.
      rows.push({ pattern: route.pattern, type: "static", prerendered: true });
    } else {
      rows.push({ pattern: route.pattern, type, revalidate });
    }
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
    const corner = rows.length === 1 ? "─" : i === 0 ? "┌" : isLast ? "└" : "├";
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

  // Speculative-render note — shown when any routes were confirmed static by prerender
  const hasPrerendered = rows.some((r) => r.prerendered);
  if (hasPrerendered) {
    lines.push("");
    lines.push(
      "  ○ Routes marked static were confirmed by speculative prerender (attempted render",
    );
    lines.push("    succeeded without dynamic API usage).");
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
  pageExtensions?: string[];
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
