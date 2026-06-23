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
 * Classification uses AST-based static source analysis (no module execution).
 * Runtime/prerender results are still treated as stronger evidence where
 * available; AST analysis only reads top-level static exports.
 *
 * Limitation: without running the build, we cannot detect dynamic API usage
 * (headers(), cookies(), connection(), etc.) that implicitly forces a route
 * dynamic. Routes without explicit `export const dynamic` or
 * `export const revalidate` are classified as "unknown" rather than "static"
 * to avoid false confidence.
 */

import fs from "node:fs";
import { parseSync } from "vite";
import type { ESTree } from "vite";
import type { Route } from "../routing/pages-router.js";
import type { AppRoute } from "../routing/app-router.js";
import { findDir } from "../utils/project.js";
import type { LayoutBuildClassification } from "./layout-classification-types.js";
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
};

type AppRouteRenderEntry = Pick<AppRoute, "pagePath" | "routePath" | "parallelSlots">;
type ArrowFunctionExpression = ESTree.ArrowFunctionExpression;
type BindingPattern = ESTree.BindingPattern;
type BlockStatement = ESTree.BlockStatement;
type Expression = ESTree.Expression;
type FunctionBody = ESTree.FunctionBody;
type FunctionLike = ESTree.Function | ArrowFunctionExpression;
type ModuleExportName = ESTree.ModuleExportName;
type ObjectExpression = ESTree.ObjectExpression;
type Program = ESTree.Program;
type PropertyKey = ESTree.PropertyKey;
type Statement = ESTree.Statement;
type VariableDeclarator = ESTree.VariableDeclarator;

export function getAppRouteRenderEntryPath(route: AppRouteRenderEntry): string | null {
  if (route.pagePath) return route.pagePath;
  if (route.routePath) return null;

  for (const slot of route.parallelSlots) {
    if (slot.pagePath) return slot.pagePath;
  }

  for (const slot of route.parallelSlots) {
    if (slot.defaultPath) return slot.defaultPath;
  }

  return null;
}

// ─── Static export analysis ──────────────────────────────────────────────────

type StaticNumberValue = number | false;

function parseRouteModuleWithLang(code: string, lang: "ts" | "tsx"): Program | null {
  try {
    const result = parseSync(`vinext-route.${lang}`, code, {
      astType: "ts",
      lang,
      sourceType: "module",
    });

    return result.errors.some((error) => error.severity === "Error") ? null : result.program;
  } catch {
    return null;
  }
}

function parseRouteModule(code: string): Program | null {
  return parseRouteModuleWithLang(code, "tsx") ?? parseRouteModuleWithLang(code, "ts");
}

function moduleExportNameValue(name: ModuleExportName): string | null {
  if (name.type === "Identifier") return name.name;
  if (name.type === "Literal" && typeof name.value === "string") return name.value;
  return null;
}

function bindingName(pattern: BindingPattern): string | null {
  return pattern.type === "Identifier" ? pattern.name : null;
}

function declarationHasBindingName(declaration: Statement | null, name: string): boolean {
  if (declaration === null) return false;

  if (declaration.type === "FunctionDeclaration") {
    return declaration.id?.name === name;
  }

  if (declaration.type !== "VariableDeclaration") return false;

  return declaration.declarations.some((declaration) => bindingName(declaration.id) === name);
}

/**
 * Returns true if the source code contains an export declaration with the given name.
 * For re-export specifiers, this intentionally follows Next.js' static analyzer
 * and checks the local/original binding name.
 * Handles all three common export forms:
 *   export function foo() {}
 *   export const foo = ...
 *   export { foo }
 */
export function hasNamedExport(code: string, name: string): boolean {
  const program = parseRouteModule(code);
  if (!program) return false;
  return hasNamedExportInProgram(program, name);
}

function hasNamedExportInProgram(program: Program, name: string): boolean {
  for (const node of program.body) {
    if (node.type !== "ExportNamedDeclaration") continue;

    if (declarationHasBindingName(node.declaration, name)) return true;

    for (const specifier of node.specifiers) {
      if (moduleExportNameValue(specifier.local) === name) {
        return true;
      }
    }
  }
  return false;
}

function unwrapStaticExpression(expression: Expression): Expression {
  let current = expression;
  while (
    current.type === "ParenthesizedExpression" ||
    current.type === "TSAsExpression" ||
    current.type === "TSSatisfiesExpression" ||
    current.type === "TSTypeAssertion" ||
    current.type === "TSNonNullExpression"
  ) {
    current = current.expression;
  }
  return current;
}

function findExportedConstInitializer(code: string, name: string): Expression | null {
  const program = parseRouteModule(code);
  if (!program) return null;
  return findExportedConstInitializerInProgram(program, name);
}

function findExportedConstInitializerInProgram(program: Program, name: string): Expression | null {
  for (const node of program.body) {
    if (node.type !== "ExportNamedDeclaration") continue;
    const declaration = node.declaration;
    if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") continue;

    for (const declarator of declaration.declarations) {
      if (bindingName(declarator.id) === name) {
        return declarator.init;
      }
    }
  }

  return null;
}

/**
 * Extracts the string value of `export const <name> = "value"`.
 * Handles TypeScript annotations/assertions and no-substitution template literals.
 * Returns null if the export is absent or not a string literal.
 */
export function extractExportConstString(code: string, name: string): string | null {
  const initializer = findExportedConstInitializer(code, name);
  return extractStringFromConstInitializer(initializer);
}

function extractExportConstStringFromProgram(program: Program, name: string): string | null {
  return extractStringFromConstInitializer(findExportedConstInitializerInProgram(program, name));
}

function extractStringFromConstInitializer(initializer: Expression | null): string | null {
  if (initializer === null) return null;

  const expression = unwrapStaticExpression(initializer);
  if (expression.type === "Literal" && typeof expression.value === "string") {
    return expression.value;
  }

  if (expression.type === "TemplateLiteral" && expression.expressions.length === 0) {
    return expression.quasis[0]?.value.cooked ?? expression.quasis[0]?.value.raw ?? null;
  }

  return null;
}

/**
 * Extracts the numeric value of `export const <name> = <number|false>`.
 * Supports integers, decimals, negative values, `Infinity`, and `false`.
 * `false` is returned as `Infinity` because `export const revalidate = false`
 * means "cache indefinitely" in Next.js segment config.
 * Handles TypeScript annotations/assertions and JavaScript numeric separators.
 * Returns null if the export is absent or not a number/`false`.
 */
export function extractExportConstNumber(code: string, name: string): number | null {
  const initializer = findExportedConstInitializer(code, name);
  return extractNumberFromConstInitializer(initializer);
}

function extractExportConstNumberFromProgram(program: Program, name: string): number | null {
  return extractNumberFromConstInitializer(findExportedConstInitializerInProgram(program, name));
}

function extractNumberFromConstInitializer(initializer: Expression | null): number | null {
  if (initializer === null) return null;

  const value = extractStaticNumberValue(initializer);
  if (value === null) return null;
  return value === false ? Infinity : value;
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
  const program = parseRouteModule(code);
  if (!program) return extractWrappedGetStaticPropsRevalidate(code);
  return extractGetStaticPropsRevalidateFromProgram(program, code);
}

function extractGetStaticPropsRevalidateFromProgram(
  program: Program,
  fallbackCode: string,
): number | false | null {
  const getStaticProps = findExportedGetStaticProps(program);
  if (getStaticProps === "external") return null;
  if (getStaticProps === null) return extractWrappedGetStaticPropsRevalidate(fallbackCode);

  return extractFunctionRevalidate(getStaticProps);
}

function extractStaticNumberValue(expression: Expression): StaticNumberValue | null {
  const unwrapped = unwrapStaticExpression(expression);

  if (unwrapped.type === "Literal") {
    if (typeof unwrapped.value === "number") return unwrapped.value;
    if (unwrapped.value === false) return false;
    return null;
  }

  if (unwrapped.type === "Identifier" && unwrapped.name === "Infinity") {
    return Infinity;
  }

  if (unwrapped.type === "UnaryExpression") {
    const argument = extractStaticNumberValue(unwrapped.argument);
    if (typeof argument !== "number") return null;
    if (unwrapped.operator === "-") return -argument;
    if (unwrapped.operator === "+") return argument;
    return null;
  }

  return null;
}

function findExportedGetStaticProps(program: Program): FunctionLike | "external" | null {
  let hasLocalGetStaticPropsExport = false;

  for (const node of program.body) {
    if (node.type !== "ExportNamedDeclaration") continue;

    const declaration = node.declaration;
    if (declaration?.type === "FunctionDeclaration" && declaration.id?.name === "getStaticProps") {
      return declaration;
    }

    if (declaration?.type === "VariableDeclaration") {
      const direct = findFunctionLikeVariable(declaration.declarations, "getStaticProps");
      if (direct) return direct;
    }

    for (const specifier of node.specifiers) {
      const localName = moduleExportNameValue(specifier.local);
      if (localName !== "getStaticProps") continue;
      if (node.source !== null) return "external";
      hasLocalGetStaticPropsExport = true;
    }
  }

  if (!hasLocalGetStaticPropsExport) return null;

  for (const node of program.body) {
    if (node.type === "FunctionDeclaration" && node.id?.name === "getStaticProps") {
      return node;
    }

    if (node.type === "VariableDeclaration") {
      const local = findFunctionLikeVariable(node.declarations, "getStaticProps");
      if (local) return local;
    }
  }

  return null;
}

function findFunctionLikeVariable(
  declarations: readonly VariableDeclarator[],
  name: string,
): FunctionLike | null {
  for (const declaration of declarations) {
    if (bindingName(declaration.id) !== name || declaration.init === null) continue;
    const initializer = unwrapStaticExpression(declaration.init);
    if (
      initializer.type === "FunctionExpression" ||
      initializer.type === "ArrowFunctionExpression"
    ) {
      return initializer;
    }
  }

  return null;
}

function extractWrappedGetStaticPropsRevalidate(code: string): number | false | null {
  // Exported helpers are also used by tests with bare `return { ... }` fragments,
  // which are not valid module source until wrapped in a synthetic function.
  const program = parseRouteModule(`function __vinextGetStaticProps() {\n${code}\n}`);
  if (!program) return null;

  for (const node of program.body) {
    if (node.type === "FunctionDeclaration" && node.id?.name === "__vinextGetStaticProps") {
      return extractFunctionRevalidate(node);
    }
  }

  return null;
}

function extractFunctionRevalidate(fn: FunctionLike): number | false | null {
  if (fn.type === "ArrowFunctionExpression" && fn.body.type !== "BlockStatement") {
    const expression = unwrapStaticExpression(fn.body);
    return expression.type === "ObjectExpression" ? extractObjectRevalidate(expression) : null;
  }

  if (!fn.body || fn.body.type !== "BlockStatement") return null;
  return extractBlockRevalidate(fn.body);
}

function extractBlockRevalidate(block: BlockStatement | FunctionBody): number | false | null {
  for (const statement of block.body) {
    const result = extractStatementRevalidate(statement);
    if (result !== null) return result;
  }

  return null;
}

function extractStatementRevalidate(statement: Statement): number | false | null {
  if (statement.type === "ReturnStatement") {
    if (!statement.argument) return null;
    const argument = unwrapStaticExpression(statement.argument);
    return argument.type === "ObjectExpression" ? extractObjectRevalidate(argument) : null;
  }

  if (statement.type === "BlockStatement") {
    return extractBlockRevalidate(statement);
  }

  if (statement.type === "IfStatement") {
    return (
      extractStatementRevalidate(statement.consequent) ??
      (statement.alternate ? extractStatementRevalidate(statement.alternate) : null)
    );
  }

  if (
    statement.type === "ForStatement" ||
    statement.type === "ForInStatement" ||
    statement.type === "ForOfStatement" ||
    statement.type === "WhileStatement" ||
    statement.type === "DoWhileStatement" ||
    statement.type === "WithStatement" ||
    statement.type === "LabeledStatement"
  ) {
    return extractStatementRevalidate(statement.body);
  }

  if (statement.type === "SwitchStatement") {
    for (const switchCase of statement.cases) {
      for (const consequent of switchCase.consequent) {
        const result = extractStatementRevalidate(consequent);
        if (result !== null) return result;
      }
    }
    return null;
  }

  if (statement.type === "TryStatement") {
    return (
      extractBlockRevalidate(statement.block) ??
      (statement.handler ? extractBlockRevalidate(statement.handler.body) : null) ??
      (statement.finalizer ? extractBlockRevalidate(statement.finalizer) : null)
    );
  }

  return null;
}

function extractObjectRevalidate(object: ObjectExpression): number | false | null {
  for (const property of object.properties) {
    if (
      property.type !== "Property" ||
      property.computed ||
      propertyName(property.key) !== "revalidate"
    ) {
      continue;
    }

    return extractStaticNumberValue(property.value);
  }

  return null;
}

function propertyName(key: PropertyKey): string | null {
  if (key.type === "Identifier") return key.name;
  if (key.type === "Literal" && typeof key.value === "string") return key.value;
  return null;
}

// ─── Layout segment config classification ────────────────────────────────────

/**
 * Classifies a layout file by its segment config exports (`dynamic`, `revalidate`).
 *
 * Returns a tagged `LayoutBuildClassification` carrying both the decision and
 * the specific segment-config field that produced it. `{ kind: "absent" }`
 * means no segment config is present and the caller should defer to the next
 * layer (module graph analysis).
 *
 * Unlike page classification, positive `revalidate` values are not meaningful
 * for layout skip decisions — ISR is a page-level concept. Only the extremes
 * (`revalidate = 0` → dynamic, `revalidate = Infinity` → static) are decisive.
 */
export function classifyLayoutSegmentConfig(code: string): LayoutBuildClassification {
  const program = parseRouteModule(code);
  const dynamicValue = program ? extractExportConstStringFromProgram(program, "dynamic") : null;
  if (dynamicValue === "force-dynamic") {
    return {
      kind: "dynamic",
      reason: { layer: "segment-config", key: "dynamic", value: "force-dynamic" },
    };
  }
  if (dynamicValue === "force-static" || dynamicValue === "error") {
    return {
      kind: "static",
      reason: { layer: "segment-config", key: "dynamic", value: dynamicValue },
    };
  }

  const revalidateValue = program
    ? extractExportConstNumberFromProgram(program, "revalidate")
    : null;
  if (revalidateValue === Infinity) {
    return {
      kind: "static",
      reason: { layer: "segment-config", key: "revalidate", value: Infinity },
    };
  }
  if (revalidateValue === 0) {
    return {
      kind: "dynamic",
      reason: { layer: "segment-config", key: "revalidate", value: 0 },
    };
  }

  return { kind: "absent" };
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

  const program = parseRouteModule(code);

  if (program && hasNamedExportInProgram(program, "getServerSideProps")) {
    return { type: "ssr" };
  }

  if (program && hasNamedExportInProgram(program, "getStaticProps")) {
    const revalidate = extractGetStaticPropsRevalidateFromProgram(program, code);

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

  const program = parseRouteModule(code);

  // Check `export const dynamic`
  const dynamicValue = program ? extractExportConstStringFromProgram(program, "dynamic") : null;
  if (dynamicValue === "force-dynamic") {
    return { type: "ssr" };
  }
  if (dynamicValue === "force-static" || dynamicValue === "error") {
    // "error" enforces static rendering — it throws if dynamic APIs are used,
    // so the page is statically rendered (same as force-static for classification).
    return { type: "static" };
  }

  // Check `export const revalidate`
  const revalidateValue = program
    ? extractExportConstNumberFromProgram(program, "revalidate")
    : null;
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
    rows.push({ pattern: route.pattern, type, revalidate });
  }

  for (const route of options.apiRoutes ?? []) {
    rows.push({ pattern: route.pattern, type: "api" });
  }

  for (const route of options.appRoutes ?? []) {
    const renderEntryPath = getAppRouteRenderEntryPath(route);
    const { type, revalidate } = classifyAppRoute(
      renderEntryPath,
      route.routePath,
      route.isDynamic,
    );
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

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Scans the project at `root`, classifies all routes, and prints the
 * Next.js-style build report to stdout.
 *
 * `root` must be forward-slash — it is passed to `findDir`. The caller (the
 * `vinext build` entry in cli.ts) normalizes it.
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
