import type { ESTree } from "vite";

export type ScriptParserLanguage = "js" | "jsx" | "ts" | "tsx";

const SCRIPT_MODULE_EXTENSION_RE = /^\.(?:[cm]?[jt]s|[jt]sx)$/i;
export const SCRIPT_MODULE_ID_RE = /\.(?:[cm]?[jt]s|[jt]sx)(?:[?#].*)?$/i;
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

export function isIdentifierNamed(value: ESTree.Node | null | undefined, name: string): boolean {
  return value?.type === "Identifier" && value.name === name;
}

export function getAstName(node: ESTree.Node | null | undefined): string | null {
  if (node?.type === "Identifier") return node.name;
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  return null;
}

/** Remove syntax-only wrappers while preserving the underlying expression. */
export function unwrapExpression(node: ESTree.Node | null | undefined): ESTree.Node | null {
  if (!node) return null;
  if (
    node.type === "ChainExpression" ||
    node.type === "ParenthesizedExpression" ||
    node.type === "TSAsExpression" ||
    node.type === "TSInstantiationExpression" ||
    node.type === "TSNonNullExpression" ||
    node.type === "TSSatisfiesExpression" ||
    node.type === "TSTypeAssertion"
  ) {
    return unwrapExpression(node.expression);
  }
  return node;
}

/** Return the value of a string literal node, without evaluating expressions. */
export function stringLiteralValue(node: ESTree.Node | null | undefined): string | null {
  if (node?.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  return null;
}

/** Return the value of a boolean literal node, without evaluating expressions. */
export function booleanLiteralValue(node: ESTree.Node | null | undefined): boolean | null {
  return node?.type === "Literal" && typeof node.value === "boolean" ? node.value : null;
}

/**
 * Return a statically known string literal, including an interpolation-free
 * template literal. This deliberately does not fold concatenations or other
 * expressions.
 */
export function staticStringValue(node: ESTree.Node | null | undefined): string | null {
  if (!node) return null;

  const literal = stringLiteralValue(node);
  if (literal !== null) return literal;
  if (node.type !== "TemplateLiteral" || node.expressions.length !== 0) return null;

  const quasi = node.quasis[0];
  if (!quasi || node.quasis.length !== 1) return null;

  const { cooked, raw } = quasi.value;
  return typeof cooked === "string" ? cooked : typeof raw === "string" ? raw : null;
}

export function forEachAstChild(node: ESTree.Node, callback: (child: ESTree.Node) => void): void {
  for (const [key, value] of Object.entries(node)) {
    if (SKIP_CHILD_KEYS.has(key)) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "object" && item !== null && "type" in item) {
          callback(item as ESTree.Node);
        }
      }
    } else if (typeof value === "object" && value !== null && "type" in value) {
      // Object.entries() erases the discriminated-union type of Node fields.
      callback(value as ESTree.Node);
    }
  }
}

/**
 * Visit an AST in depth-first order. Returning `false` prunes the current
 * node's subtree, which is useful once a transform has claimed a complete
 * expression. Parent links and source-location metadata are skipped by
 * {@link forEachAstChild}, so OXC's cyclic `parent` references are safe.
 */
export function walkAst(node: ESTree.Node, visitor: (node: ESTree.Node) => boolean | void): void {
  if (visitor(node) === false) return;
  forEachAstChild(node, (child) => walkAst(child, visitor));
}

export function collectBindingNames(
  node: ESTree.Node | null | undefined,
  target: Set<string>,
): void {
  if (!node) return;

  // Binding patterns are a deliberately small subset of the full node union.
  // oxlint-disable-next-line typescript/switch-exhaustiveness-check
  switch (node.type) {
    case "Identifier":
      target.add(node.name);
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
      for (const element of node.elements) collectBindingNames(element, target);
      return;
    case "ObjectPattern":
      for (const property of node.properties) {
        collectBindingNames(
          property.type === "Property" ? property.value : property.argument,
          target,
        );
      }
      return;
    case "Property":
      collectBindingNames(node.value, target);
      return;
    default:
      return;
  }
}
