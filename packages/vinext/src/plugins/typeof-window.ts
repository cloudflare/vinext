import { parseAst } from "vite";
import MagicString from "magic-string";
import { forEachAstChild, hasRange, isAstRecord, isIdentifierNamed } from "./ast-utils.js";

type WindowType = "object" | "undefined";

type AstNode = Parameters<typeof forEachAstChild>[0];

function stringLiteralValue(node: unknown): string | null {
  if (!isAstRecord(node)) return null;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  return null;
}

function evaluateTypeofWindowComparison(node: unknown, replacement: WindowType): boolean | null {
  if (!isAstRecord(node) || node.type !== "BinaryExpression") return null;
  if (!["==", "===", "!=", "!=="].includes(String(node.operator))) return null;

  const left = isAstRecord(node.left) ? node.left : null;
  const right = isAstRecord(node.right) ? node.right : null;
  const leftIsTypeofWindow =
    left?.type === "UnaryExpression" &&
    left.operator === "typeof" &&
    isIdentifierNamed(left.argument, "window");
  const rightIsTypeofWindow =
    right?.type === "UnaryExpression" &&
    right.operator === "typeof" &&
    isIdentifierNamed(right.argument, "window");

  const comparedValue = leftIsTypeofWindow
    ? stringLiteralValue(right)
    : rightIsTypeofWindow
      ? stringLiteralValue(left)
      : null;
  if (comparedValue === null) return null;

  const equal = replacement === comparedValue;
  return node.operator === "==" || node.operator === "===" ? equal : !equal;
}

export function replaceTypeofWindow(code: string, replacement: WindowType) {
  if (!/typeof\s+window/.test(code)) return null;

  let ast: ReturnType<typeof parseAst>;
  try {
    ast = parseAst(code);
  } catch {
    return null;
  }

  const output = new MagicString(code);
  let changed = false;

  function visit(node: AstNode): void {
    if (node.type === "IfStatement" && hasRange(node)) {
      const result = evaluateTypeofWindowComparison(node.test, replacement);
      if (result !== null) {
        const selected = result ? node.consequent : node.alternate;
        if (isAstRecord(selected) && hasRange(selected)) {
          output.overwrite(node.start, node.end, code.slice(selected.start, selected.end));
        } else {
          output.overwrite(node.start, node.end, ";");
        }
        changed = true;
        return;
      }
    }

    if (
      node.type === "UnaryExpression" &&
      node.operator === "typeof" &&
      isIdentifierNamed(node.argument, "window") &&
      hasRange(node)
    ) {
      output.overwrite(node.start, node.end, JSON.stringify(replacement));
      changed = true;
      return;
    }

    forEachAstChild(node, visit);
  }

  for (const node of ast.body) {
    if (isAstRecord(node)) visit(node);
  }
  if (!changed) return null;

  return {
    code: output.toString(),
    map: output.generateMap({ hires: "boundary" }),
  };
}
