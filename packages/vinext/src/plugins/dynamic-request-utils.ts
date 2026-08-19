import { hasRange, isAstRecord, type AstRecord } from "./ast-utils.js";

function astNode(value: unknown): AstRecord | null {
  return isAstRecord(value) ? value : null;
}

export function hasDynamicRequestIgnoreDirective(
  code: string,
  requestNode: AstRecord,
  argumentNode: AstRecord,
): boolean {
  if (!hasRange(requestNode) || !hasRange(argumentNode)) return false;
  const comments: string[] = [];
  const callee = astNode(requestNode.callee);
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
