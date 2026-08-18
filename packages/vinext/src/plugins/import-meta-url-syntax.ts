import {
  hasRange,
  isAstRecord,
  isIdentifierNamed,
  nodeArray,
  unwrapExpression,
  type AstRange,
  type AstRecord,
} from "./ast-utils.js";

function isImportMetaNode(value: unknown): boolean {
  return (
    isAstRecord(value) &&
    value.type === "MetaProperty" &&
    isIdentifierNamed(value.meta, "import") &&
    isIdentifierNamed(value.property, "meta")
  );
}

export function isImportMetaUrlNode(value: unknown): value is AstRange {
  return (
    isAstRecord(value) &&
    value.type === "MemberExpression" &&
    value.computed !== true &&
    hasRange(value) &&
    isImportMetaNode(value.object) &&
    isIdentifierNamed(value.property, "url")
  );
}

export function isImportMetaUrlOrChainedNode(value: unknown): value is AstRange {
  return isImportMetaUrlNode(unwrapExpression(value));
}

// Only matches bare `new URL(...)`, not `new globalThis.URL(...)` or
// `new window.URL(...)`. This is also Vite's own asset-detection boundary.
export function isNewUrlExpression(value: unknown): value is AstRecord {
  return (
    isAstRecord(value) && value.type === "NewExpression" && isIdentifierNamed(value.callee, "URL")
  );
}

// A literal relative module URL has the same ESM identity as its relative
// specifier, so it can be represented as a normal bundler-visible import.
export function relativeDynamicImportUrlSpecifier(source: unknown): string | null {
  const expression = unwrapExpression(source);
  if (
    expression?.type !== "MemberExpression" ||
    expression.computed === true ||
    !isIdentifierNamed(expression.property, "href")
  ) {
    return null;
  }

  const urlExpression = unwrapExpression(expression.object);
  if (!isNewUrlExpression(urlExpression)) return null;

  const args = nodeArray(urlExpression.arguments);
  const specifier = unwrapExpression(args[0]);
  if (
    args.length !== 2 ||
    specifier?.type !== "Literal" ||
    typeof specifier.value !== "string" ||
    (!specifier.value.startsWith("./") && !specifier.value.startsWith("../")) ||
    !isImportMetaUrlOrChainedNode(args[1])
  ) {
    return null;
  }

  return specifier.value;
}
