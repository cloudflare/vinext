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

export function hasDynamicRequestIgnoreDirective(
  code: string,
  requestNode: AstRecord,
  argumentNode: AstRecord,
): boolean {
  if (!hasRange(requestNode) || !hasRange(argumentNode)) return false;
  const comments: string[] = [];
  const callee = isAstRecord(requestNode.callee) ? requestNode.callee : null;
  let index =
    callee && hasRange(callee)
      ? callee.end
      : requestNode.type === "ImportExpression"
        ? requestNode.start + "import".length
        : requestNode.start;

  while (index < argumentNode.start) {
    if (/\s/.test(code[index])) {
      index++;
      continue;
    }
    if (code.startsWith("/*", index)) {
      const end = code.indexOf("*/", index + 2);
      if (end === -1 || end + 2 > argumentNode.start) return false;
      index = end + 2;
      continue;
    }
    if (code.startsWith("//", index)) {
      while (index < argumentNode.start && code[index] !== "\n" && code[index] !== "\r") index++;
      continue;
    }
    break;
  }
  if (code[index] !== "(") return false;
  index++;

  while (index < argumentNode.start) {
    if (/\s/.test(code[index])) {
      index++;
      continue;
    }
    if (code.startsWith("/*", index)) {
      const end = code.indexOf("*/", index + 2);
      if (end === -1 || end + 2 > argumentNode.start) return false;
      comments.push(code.slice(index + 2, end));
      index = end + 2;
      continue;
    }
    if (code.startsWith("//", index)) {
      let end = index + 2;
      while (end < argumentNode.start && code[end] !== "\n" && code[end] !== "\r") end++;
      comments.push(code.slice(index + 2, end));
      index = end;
      continue;
    }
    return false;
  }

  let ignore: boolean | undefined;
  for (const comment of comments) {
    const text = comment.trim();
    if (text === "@vite-ignore" && requestNode.type === "ImportExpression") {
      ignore = true;
      continue;
    }
    const separator = text.indexOf(":");
    if (separator === -1) continue;
    const directive = text.slice(0, separator).trim();
    if (directive !== "webpackIgnore" && directive !== "turbopackIgnore") continue;
    const value = text.slice(separator + 1).trim();
    if (value === "true") ignore = true;
    else if (value === "false") ignore = false;
  }
  return ignore === true;
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
