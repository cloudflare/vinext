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
      while (index < argumentNode.start && !isLineTerminator(code[index])) index++;
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
      while (end < argumentNode.start && !isLineTerminator(code[end])) end++;
      comments.push(code.slice(index + 2, end));
      index = end;
      continue;
    }
    // Parentheses are omitted from Oxc expression ranges, so transparent
    // wrappers around the first argument can occur before its reported start.
    if (code[index] === "(") {
      index++;
      continue;
    }
    return false;
  }

  let viteIgnore = false;
  let webpackIgnore: boolean | undefined;
  let turbopackIgnore: boolean | undefined;
  for (const comment of comments) {
    const text = comment.trim();
    if (
      text === "@vite-ignore" &&
      (requestNode.type === "ImportExpression" || requestNode.type === "NewExpression")
    ) {
      viteIgnore = true;
      continue;
    }
    const magicIgnore = magicCommentIgnoreValues(text);
    if (magicIgnore.webpack !== undefined) webpackIgnore = magicIgnore.webpack;
    if (magicIgnore.turbopack !== undefined) turbopackIgnore = magicIgnore.turbopack;
  }
  return viteIgnore || webpackIgnore === true || turbopackIgnore === true;
}

function isLineTerminator(character: string | undefined): boolean {
  return (
    character === "\n" || character === "\r" || character === "\u2028" || character === "\u2029"
  );
}

function magicCommentIgnoreValues(comment: string): {
  webpack: boolean | undefined;
  turbopack: boolean | undefined;
} {
  let webpack: boolean | undefined;
  let turbopack: boolean | undefined;
  for (const option of splitTopLevelOptions(comment)) {
    const separator = topLevelColon(option);
    if (separator === -1) continue;
    const name = withoutLineComments(option.slice(0, separator)).trim();
    if (name !== "webpackIgnore" && name !== "turbopackIgnore") continue;
    const value = withoutLineComments(option.slice(separator + 1)).trim();
    if (value !== "true" && value !== "false") continue;
    if (name === "webpackIgnore") webpack = value === "true";
    else turbopack = value === "true";
  }
  return { webpack, turbopack };
}

function withoutLineComments(value: string): string {
  return value.replace(/\/\/[^\n\r\u2028\u2029]*/g, "");
}

function splitTopLevelOptions(value: string): string[] {
  const options: string[] = [];
  let start = 0;
  for (const index of topLevelDelimiterPositions(value, ",")) {
    options.push(value.slice(start, index));
    start = index + 1;
  }
  options.push(value.slice(start));
  return options;
}

function topLevelColon(value: string): number {
  return topLevelDelimiterPositions(value, ":")[0] ?? -1;
}

function topLevelDelimiterPositions(value: string, delimiter: "," | ":"): number[] {
  const positions: number[] = [];
  let depth = 0;
  let expressionExpected = true;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (/\s/.test(character)) continue;
    if (character === '"' || character === "'" || character === "`") {
      index = endOfQuotedValue(value, index, character);
      expressionExpected = false;
      continue;
    }
    if (character === "/" && value[index + 1] === "/") {
      index += 2;
      while (index < value.length && !isLineTerminator(value[index])) index++;
      continue;
    }
    if (character === "/" && expressionExpected) {
      index = endOfRegexLiteral(value, index);
      expressionExpected = false;
      continue;
    }
    if (character === "(" || character === "[" || character === "{") {
      depth++;
      expressionExpected = true;
    } else if (character === ")" || character === "]" || character === "}") {
      depth = Math.max(0, depth - 1);
      expressionExpected = false;
    } else if (character === delimiter && depth === 0) {
      positions.push(index);
      expressionExpected = true;
    } else if (isIdentifierCharacter(character) || /[0-9.]/.test(character)) {
      while (
        index + 1 < value.length &&
        (isIdentifierCharacter(value[index + 1]) || /[0-9.]/.test(value[index + 1]))
      ) {
        index++;
      }
      expressionExpected = false;
    } else {
      expressionExpected = character !== "+" || value[index + 1] !== "+";
      if (character === "-" && value[index + 1] === "-") expressionExpected = false;
    }
  }
  return positions;
}

function endOfQuotedValue(value: string, start: number, quote: string): number {
  let escaped = false;
  for (let index = start + 1; index < value.length; index++) {
    const character = value[index];
    if (escaped) escaped = false;
    else if (character === "\\") escaped = true;
    else if (character === quote) return index;
  }
  return value.length - 1;
}

function endOfRegexLiteral(value: string, start: number): number {
  let escaped = false;
  let characterClass = false;
  for (let index = start + 1; index < value.length; index++) {
    const character = value[index];
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "[") {
      characterClass = true;
    } else if (character === "]") {
      characterClass = false;
    } else if (character === "/" && !characterClass) {
      while (isIdentifierCharacter(value[index + 1])) index++;
      return index;
    }
  }
  return value.length - 1;
}

function isIdentifierCharacter(character: string | undefined): boolean {
  return character !== undefined && /[\w$]/.test(character);
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

export function hasBundlerIgnoreInNewUrl(code: string, source: unknown): boolean {
  const expression = unwrapExpression(source);
  let urlExpression: AstRecord | null = null;
  if (expression?.type === "NewExpression" && isIdentifierNamed(expression.callee, "URL")) {
    urlExpression = expression;
  } else if (expression?.type === "MemberExpression" && isAstRecord(expression.object)) {
    urlExpression = unwrapExpression(expression.object);
  }
  if (!isNewUrlExpression(urlExpression) || !hasRange(urlExpression)) return false;
  const specifier = unwrapExpression(nodeArray(urlExpression.arguments)[0]);
  if (!specifier || !hasRange(specifier)) return false;
  return hasDynamicRequestIgnoreDirective(code, urlExpression, specifier);
}
