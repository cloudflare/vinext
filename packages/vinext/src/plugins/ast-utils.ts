export type AstRecord = {
  type: string;
  start?: number;
  end?: number;
  [key: string]: unknown;
};

export type AstRange = AstRecord & {
  start: number;
  end: number;
};

export type ScriptParserLanguage = "js" | "jsx" | "ts" | "tsx";

const SCRIPT_MODULE_EXTENSION_RE = /^\.(?:[cm]?[jt]s|[jt]sx)$/i;
export const SCRIPT_MODULE_ID_RE = /\.(?:[cm]?[jt]s|[jt]sx)(?:[?#].*)?$/i;
const TRANSPARENT_EXPRESSION_TYPES = new Set([
  "ChainExpression",
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSInstantiationExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
]);

/**
 * Cheap pre-parse gate for plugins that only transform *dynamic* `import(...)`.
 *
 * Static imports — `import x from "..."`, `import { ... } from "..."`,
 * `import "..."` — never place a `(` (nor a comment leading to one) immediately
 * after the `import` keyword. Plugins that act only on dynamic `import(...)` use
 * this to skip `parseAst` for the overwhelming majority of modules in a large
 * app: at ~5k routes, where almost every module is a static-import-only page,
 * it removes most of the build's AST-parse/GC cost. This is a deliberate,
 * measured performance filter — keep it a regex, never a parse.
 *
 * It intentionally errs toward over-matching: a false positive costs one
 * redundant parse, whereas a false negative would silently skip a real dynamic
 * import (a correctness bug). `\s*[(/]` therefore tolerates whitespace and
 * block/line comments between the `import` keyword and its parenthesis.
 *
 * Usable directly as a Rolldown `transform.filter.code` regex, or via
 * {@link mayContainDynamicImport} for an in-handler prescan.
 */
export const DYNAMIC_IMPORT_PRESCAN = /\bimport\s*[(/]/;

/**
 * Whether `code` might contain a dynamic `import(...)` call. See
 * {@link DYNAMIC_IMPORT_PRESCAN} — a cheap, deliberately over-inclusive regex
 * gate used to avoid parsing static-import-only modules.
 */
export function mayContainDynamicImport(code: string): boolean {
  return DYNAMIC_IMPORT_PRESCAN.test(code);
}

/**
 * Select the OXC parser mode for a JavaScript/TypeScript module id.
 *
 * JavaScript-family files intentionally use the JSX parser. Next.js accepts
 * JSX in `.js` files, and every caller using this helper runs before JSX has
 * necessarily been lowered.
 */
export function scriptParserLanguage(id: string): ScriptParserLanguage | null {
  const cleanId = id.split(/[?#]/, 1)[0];
  const extensionIndex = cleanId.lastIndexOf(".");
  if (extensionIndex === -1) return null;

  const extension = cleanId.slice(extensionIndex).toLowerCase();
  if (!SCRIPT_MODULE_EXTENSION_RE.test(extension)) return null;
  if (extension === ".ts" || extension === ".mts" || extension === ".cts") return "ts";
  if (extension === ".tsx") return "tsx";
  return "jsx";
}

const SKIP_CHILD_KEYS = new Set(["type", "parent", "loc", "start", "end"]);

function getObjectProperty(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return null;
  return Reflect.get(value, key);
}

export function isAstRecord(value: unknown): value is AstRecord {
  return typeof getObjectProperty(value, "type") === "string";
}

function toAstRecord(value: unknown): AstRecord | null {
  return isAstRecord(value) ? value : null;
}

export function nodeArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function hasRange(node: AstRecord | null): node is AstRange {
  return node !== null && typeof node.start === "number" && typeof node.end === "number";
}

export function isIdentifierNamed(value: unknown, name: string): boolean {
  return isAstRecord(value) && value.type === "Identifier" && value.name === name;
}

export function getAstName(value: unknown): string | null {
  const node = toAstRecord(value);
  if (!node) return null;
  if (node.type === "Identifier" && typeof node.name === "string") return node.name;
  if (typeof node.value === "string") return node.value;
  return null;
}

/** Remove syntax-only wrappers while preserving the underlying expression. */
export function unwrapExpression(value: unknown): AstRecord | null {
  const node = toAstRecord(value);
  if (!node || !TRANSPARENT_EXPRESSION_TYPES.has(node.type)) return node;
  return unwrapExpression(node.expression);
}

/** Return the value of a string literal node, without evaluating expressions. */
export function stringLiteralValue(value: unknown): string | null {
  const node = toAstRecord(value);
  if (
    (node?.type === "Literal" || node?.type === "StringLiteral") &&
    typeof node.value === "string"
  ) {
    return node.value;
  }
  return null;
}

/** Return the value of a boolean literal node, without evaluating expressions. */
export function booleanLiteralValue(value: unknown): boolean | null {
  const node = toAstRecord(value);
  return node?.type === "Literal" && typeof node.value === "boolean" ? node.value : null;
}

/**
 * Return a statically known string literal, including an interpolation-free
 * template literal. This deliberately does not fold concatenations or other
 * expressions.
 */
export function staticStringValue(value: unknown): string | null {
  const node = toAstRecord(value);
  if (!node) return null;

  const literal = stringLiteralValue(node);
  if (literal !== null) return literal;
  if (node.type !== "TemplateLiteral" || nodeArray(node.expressions).length !== 0) return null;

  const quasis = nodeArray(node.quasis);
  if (quasis.length !== 1) return null;
  const quasi = toAstRecord(quasis[0]);
  if (quasi?.type !== "TemplateElement" || typeof quasi.value !== "object" || !quasi.value) {
    return null;
  }

  const cooked = Reflect.get(quasi.value, "cooked");
  const raw = Reflect.get(quasi.value, "raw");
  return typeof cooked === "string" ? cooked : typeof raw === "string" ? raw : null;
}

export function forEachAstChild(node: AstRecord, callback: (child: AstRecord) => void): void {
  for (const [key, value] of Object.entries(node)) {
    if (SKIP_CHILD_KEYS.has(key)) continue;
    const child = toAstRecord(value);
    if (child) {
      callback(child);
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const itemNode = toAstRecord(item);
        if (itemNode) callback(itemNode);
      }
    }
  }
}

/**
 * Visit an AST in depth-first order. Returning `false` prunes the current
 * node's subtree, which is useful once a transform has claimed a complete
 * expression. Parent links and source-location metadata are skipped by
 * {@link forEachAstChild}, so OXC's cyclic `parent` references are safe.
 */
export function walkAst(value: unknown, visitor: (node: AstRecord) => boolean | void): void {
  const node = toAstRecord(value);
  if (!node || visitor(node) === false) return;
  forEachAstChild(node, (child) => walkAst(child, visitor));
}

export function collectBindingNames(pattern: unknown, target: Set<string>): void {
  const node = toAstRecord(pattern);
  if (!node) return;

  switch (node.type) {
    case "Identifier":
      if (typeof node.name === "string") target.add(node.name);
      return;
    case "RestElement":
      collectBindingNames(node.argument, target);
      return;
    case "AssignmentPattern":
      collectBindingNames(node.left, target);
      return;
    case "TSParameterProperty":
      collectBindingNames(node.parameter, target);
      return;
    case "ArrayPattern":
      for (const element of nodeArray(node.elements)) collectBindingNames(element, target);
      return;
    case "ObjectPattern":
      for (const property of nodeArray(node.properties)) {
        const propertyNode = toAstRecord(property);
        if (!propertyNode) continue;
        collectBindingNames(
          propertyNode.type === "Property" ? propertyNode.value : propertyNode.argument,
          target,
        );
      }
      return;
    case "Property":
      collectBindingNames(node.value, target);
      return;
  }
}

/** Offset after a module's hashbang and directive prologue. */
export function directivePrologueEnd(value: unknown): number {
  const ast = toAstRecord(value);
  if (ast?.type !== "Program") return 0;

  const hashbang = ast.hashbang;
  const hashbangEnd =
    typeof hashbang === "object" && hashbang !== null ? Reflect.get(hashbang, "end") : null;
  let end = typeof hashbangEnd === "number" ? hashbangEnd : 0;

  for (const statement of nodeArray(ast.body)) {
    const node = toAstRecord(statement);
    if (
      node?.type !== "ExpressionStatement" ||
      toAstRecord(node.expression)?.type !== "Literal" ||
      typeof toAstRecord(node.expression)?.value !== "string" ||
      typeof node.end !== "number"
    ) {
      break;
    }
    end = node.end;
  }
  return end;
}
