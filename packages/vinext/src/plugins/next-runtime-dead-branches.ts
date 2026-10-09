import { parseAst, type ESTree } from "vite";
import {
  forEachAstChild,
  isIdentifierNamed,
  scriptParserLanguage,
  stringLiteralValue,
} from "./ast-utils.js";

const NEXT_RUNTIME_PRESCAN = /\bNEXT_RUNTIME\b/;
const REQUIRE_CALL_PRESCAN = /(?<![\w$.])require\s*\(/;
// A module that may declare its own `process` binding is left alone: the
// define only replaces the global. Deliberately over-inclusive.
const PROCESS_BINDING_PRESCAN =
  /\b(?:const|let|var|function|class)\s+process\b|\bimport\b[^;]*\bprocess\b[^;]*\bfrom\b|[,(]\s*process\s*[,)=]/;

function unwrapChain(node: ESTree.Node): ESTree.Node {
  return node.type === "ChainExpression" ? node.expression : node;
}

function isProcessEnvNextRuntime(node: ESTree.Node): boolean {
  const member = unwrapChain(node);
  if (member.type !== "MemberExpression") return false;
  const isNextRuntime = member.computed
    ? stringLiteralValue(member.property) === "NEXT_RUNTIME"
    : isIdentifierNamed(member.property, "NEXT_RUNTIME");
  if (!isNextRuntime) return false;
  const env = unwrapChain(member.object);
  if (env.type !== "MemberExpression") return false;
  const isEnv = env.computed
    ? stringLiteralValue(env.property) === "env"
    : isIdentifierNamed(env.property, "env");
  return isEnv && isIdentifierNamed(env.object, "process");
}

/**
 * Statically evaluate a branch test built only from comparisons of
 * `process.env.NEXT_RUNTIME` with string literals, `!`, `&&` and `||`, under
 * the value the environment defines. Anything else is `null` (unknown). The
 * test itself is never removed, so its side effects do not matter here.
 */
function evaluateNextRuntimeTest(node: ESTree.Node, runtime: string): boolean | null {
  if (node.type === "UnaryExpression" && node.operator === "!") {
    const value = evaluateNextRuntimeTest(node.argument, runtime);
    return value === null ? null : !value;
  }
  if (node.type === "LogicalExpression" && (node.operator === "&&" || node.operator === "||")) {
    const left = evaluateNextRuntimeTest(node.left, runtime);
    const right = evaluateNextRuntimeTest(node.right, runtime);
    const decisive = node.operator === "&&" ? false : true;
    if (left === decisive || right === decisive) return decisive;
    return left === !decisive && right === !decisive ? !decisive : null;
  }
  if (node.type !== "BinaryExpression") return null;
  if (!["==", "===", "!=", "!=="].includes(String(node.operator))) return null;
  const compared = isProcessEnvNextRuntime(node.left)
    ? stringLiteralValue(node.right)
    : isProcessEnvNextRuntime(node.right)
      ? stringLiteralValue(node.left)
      : null;
  if (compared === null) return null;
  const equal = compared === runtime;
  return node.operator === "==" || node.operator === "===" ? equal : !equal;
}

/**
 * Blank `node`'s source in place, keeping its length and line breaks so every
 * later position (and so any source map built on top) is unchanged.
 */
function blank(chars: string[], node: ESTree.Node, kind: "statement" | "expression"): void {
  const isBlock = node.type === "BlockStatement";
  const start = isBlock ? node.start + 1 : node.start;
  const end = isBlock ? node.end - 1 : node.end;
  for (let index = start; index < end; index++) {
    if (chars[index] !== "\n" && chars[index] !== "\r") chars[index] = " ";
  }
  // A non-block `if` arm must stay a statement, a `?:` arm an expression.
  if (!isBlock && end > start) chars[start] = kind === "statement" ? ";" : "0";
}

/**
 * Whether `node` declares a binding that is hoisted out of it: a `var`, or a
 * function declaration. Blanking such a branch would delete a binding live code
 * may still read (`if (edge) { var impl = require(x) } export default impl`),
 * so it is left to Rolldown. Nested functions scope their own `var`s.
 */
function declaresHoistedBinding(node: ESTree.Node): boolean {
  if (node.type === "FunctionDeclaration") return true;
  if (node.type === "VariableDeclaration" && node.kind === "var") return true;
  if (
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression" ||
    node.type === "ClassDeclaration" ||
    node.type === "ClassExpression"
  ) {
    return false;
  }
  let found = false;
  forEachAstChild(node, (child) => {
    if (!found && declaresHoistedBinding(child)) found = true;
  });
  return found;
}

/**
 * Remove the bodies of `if` / `?:` branches that are dead under the
 * environment's `process.env.NEXT_RUNTIME` define, when they contain a
 * `require()` call.
 *
 * Next.js folds `process.env.NEXT_RUNTIME` before it collects dependencies,
 * so `if (process.env.NEXT_RUNTIME === "edge") require(x)` never resolves `x`
 * in a Node.js build. vite-plugin-commonjs instead hoists every `require()`
 * it finds, including ones in such dead branches, to a top-level `import`
 * before Rolldown applies the define and drops the branch, so the build must
 * resolve a module the code can never load.
 *
 * Returns the rewritten code, or `undefined` when nothing changed.
 */
export function blankDeadNextRuntimeRequireBranches(
  code: string,
  id: string,
  runtime: string | undefined,
): string | undefined {
  if (runtime === undefined) return undefined;
  if (!NEXT_RUNTIME_PRESCAN.test(code) || !REQUIRE_CALL_PRESCAN.test(code)) return undefined;
  if (PROCESS_BINDING_PRESCAN.test(code)) return undefined;
  const lang = scriptParserLanguage(id);
  if (!lang) return undefined;
  let ast: ESTree.Program;
  try {
    ast = parseAst(code, { lang });
  } catch {
    return undefined;
  }

  const dead: Array<{ node: ESTree.Node; kind: "statement" | "expression" }> = [];
  const visit = (node: ESTree.Node): void => {
    if (node.type === "IfStatement" || node.type === "ConditionalExpression") {
      const value = evaluateNextRuntimeTest(node.test, runtime);
      const deadBranch = value === false ? node.consequent : value === true ? node.alternate : null;
      if (
        deadBranch &&
        REQUIRE_CALL_PRESCAN.test(code.slice(deadBranch.start, deadBranch.end)) &&
        !declaresHoistedBinding(deadBranch)
      ) {
        dead.push({
          node: deadBranch,
          kind: node.type === "IfStatement" ? "statement" : "expression",
        });
        visit(node.test);
        const live = value === false ? node.alternate : node.consequent;
        if (live) visit(live);
        return;
      }
    }
    forEachAstChild(node, visit);
  };
  visit(ast);
  if (dead.length === 0) return undefined;

  const chars = code.split("");
  for (const { node, kind } of dead) blank(chars, node, kind);
  return chars.join("");
}

/** The string value an environment's `define` gives `process.env.NEXT_RUNTIME`. */
export function definedNextRuntime(
  define: Record<string, unknown> | undefined,
): string | undefined {
  const raw = define?.["process.env.NEXT_RUNTIME"];
  if (typeof raw !== "string") return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}
