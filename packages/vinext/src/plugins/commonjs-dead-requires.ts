import MagicString from "magic-string";
import type { ESTree } from "vite";
import {
  isIdentifierNamed,
  parseProgram,
  scriptParserLanguage,
  unwrapExpression,
} from "./ast-utils.js";
import { hasAstBinding, walkAstScopes, type AstScope } from "./ast-scope.js";
import { escapeRegExp } from "../utils/regex.js";
import { COMMONJS_REQUIRE_CALL_RE } from "./commonjs-syntax.js";

type LiteralValue = string | number | boolean | null;
export type LiteralDefines = ReadonlyMap<string, LiteralValue>;

// A primary expression valid wherever the call was. One character never
// overwrites a line break, which cannot appear inside the `require` callee.
const DEAD_REQUIRE_REPLACEMENT = "0";
const literalDefinesCache = new WeakMap<object, LiteralDefines>();
const dottedDefinePatternCache = new WeakMap<LiteralDefines, RegExp | null>();

/**
 * The entries of a Vite `define` map whose replacement is a JSON literal, such
 * as `process.env.NEXT_RUNTIME` or `process.env.NODE_ENV`.
 */
export function literalDefines(define: Record<string, unknown> | undefined): LiteralDefines {
  if (!define) return new Map();
  let defines = literalDefinesCache.get(define);
  if (defines) return defines;
  const entries = new Map<string, LiteralValue>();
  for (const [key, replacement] of Object.entries(define)) {
    if (typeof replacement !== "string") continue;
    let value: unknown;
    try {
      value = JSON.parse(replacement);
    } catch {
      continue;
    }
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      entries.set(key, value);
    }
  }
  defines = entries;
  literalDefinesCache.set(define, defines);
  return defines;
}

/**
 * Vite's prefilter for unbundled server environments: it folds a module's
 * defines (in every spelling) only when the module spells a key with dots,
 * allowing `?.`, such as `process.env.NODE_ENV` or `process?.env.NODE_ENV`.
 */
function dottedDefinePattern(defines: LiteralDefines): RegExp | null {
  if (dottedDefinePatternCache.has(defines)) return dottedDefinePatternCache.get(defines)!;
  const pattern = defines.size
    ? new RegExp(
        Array.from(defines.keys(), (key) => escapeRegExp(key).replaceAll("\\.", "\\??\\.")).join(
          "|",
        ),
      )
    : null;
  dottedDefinePatternCache.set(defines, pattern);
  return pattern;
}

/** A member's property name, for `a.b` and the statically computed `a["b"]`. */
function memberPropertyName(node: ESTree.MemberExpression): string | null {
  if (!node.computed) return node.property.type === "Identifier" ? node.property.name : null;
  const property = unwrapExpression(node.property);
  return property?.type === "Literal" && typeof property.value === "string" ? property.value : null;
}

/**
 * The define key an expression reads (`process.env.X`, `process.env["X"]`,
 * `typeof window`), if any. Vite folds defines in every one of these spellings.
 */
function defineKey(value: ESTree.Node | null | undefined, scope: AstScope): string | null {
  const node = unwrapExpression(value);
  if (node?.type === "Identifier") return hasAstBinding(scope, node.name) ? null : node.name;
  if (node?.type === "MemberExpression") {
    const property = memberPropertyName(node);
    if (property === null) return null;
    const object = defineKey(node.object, scope);
    return object === null ? null : `${object}.${property}`;
  }
  if (node?.type === "UnaryExpression" && node.operator === "typeof") {
    const argument = unwrapExpression(node.argument);
    return argument?.type === "Identifier" && !hasAstBinding(scope, argument.name)
      ? `typeof ${argument.name}`
      : null;
  }
  return null;
}

/** Whether a logical expression returns its left operand without evaluating the right. */
function shortCircuits(
  operator: ESTree.LogicalExpression["operator"],
  left: LiteralValue,
): boolean {
  if (operator === "&&") return !left;
  if (operator === "||") return Boolean(left);
  return left !== null;
}

function evaluate(
  value: ESTree.Node | null | undefined,
  scope: AstScope,
  defines: LiteralDefines,
): { value: LiteralValue } | null {
  const node = unwrapExpression(value);
  if (!node) return null;
  if (node.type === "Literal") {
    const literal = node.value;
    if (
      typeof literal === "string" ||
      typeof literal === "number" ||
      typeof literal === "boolean" ||
      (literal === null && node.raw === "null")
    ) {
      return { value: literal };
    }
    return null;
  }
  const key = defineKey(node, scope);
  if (key !== null) return defines.has(key) ? { value: defines.get(key)! } : null;
  if (node.type === "UnaryExpression" && node.operator === "!") {
    const argument = evaluate(node.argument, scope, defines);
    return argument && { value: !argument.value };
  }
  if (node.type === "BinaryExpression") {
    if (!["===", "!==", "==", "!="].includes(node.operator)) return null;
    const left = evaluate(node.left, scope, defines);
    const right = left && evaluate(node.right, scope, defines);
    if (!left || !right) return null;
    const strict = node.operator === "===" || node.operator === "!==";
    const equal = strict ? left.value === right.value : left.value == right.value;
    return { value: node.operator === "===" || node.operator === "==" ? equal : !equal };
  }
  if (node.type === "LogicalExpression") {
    const left = evaluate(node.left, scope, defines);
    if (!left) return null;
    return shortCircuits(node.operator, left.value) ? left : evaluate(node.right, scope, defines);
  }
  return null;
}

/** The branch of a conditional that the literal defines make unreachable. */
function deadBranch(
  node: ESTree.Node,
  scope: AstScope,
  defines: LiteralDefines,
): ESTree.Node | null {
  if (node.type === "IfStatement" || node.type === "ConditionalExpression") {
    const test = evaluate(node.test, scope, defines);
    if (!test) return null;
    return (test.value ? node.alternate : node.consequent) ?? null;
  }
  if (node.type === "LogicalExpression") {
    const left = evaluate(node.left, scope, defines);
    return left && shortCircuits(node.operator, left.value) ? node.right : null;
  }
  return null;
}

/**
 * Blank out `require()` calls in branches that the environment's literal
 * defines make unreachable, such as the `else` of
 * `if (process.env.NEXT_RUNTIME === "nodejs")` on the server.
 *
 * vite-plugin-commonjs hoists every `require()` into a static import, so it
 * would resolve and evaluate one the bundle can never reach. Next.js folds
 * its defines before it collects dependencies and never resolves them. Each
 * call becomes `0` padded to the same length (keeping line breaks), so offsets
 * do not move and the CommonJS transform's sourcemap still maps to the
 * original source.
 */
export function blankDefineDeadRequires(
  code: string,
  id: string,
  defines: LiteralDefines,
  /**
   * Whether Vite applies the defines to every module, as in bundled
   * environments and the client (where defines are runtime globals in dev).
   * Unbundled server environments apply them only to modules matching
   * {@link dottedDefinePattern}; other modules read the real `process.env`.
   */
  definesEveryModule: boolean,
): MagicString | null {
  // vite-plugin-commonjs only transforms files with a script extension, which
  // generated modules such as vinext's virtual entries do not have.
  const lang = scriptParserLanguage(id);
  if (!lang || !COMMONJS_REQUIRE_CALL_RE.test(code)) return null;
  let mentionsDefine = false;
  if (definesEveryModule) {
    // Match only a member key's last name: `process.env["NEXT_RUNTIME"]`
    // spells the `process.env.NEXT_RUNTIME` key differently.
    for (const key of defines.keys()) {
      if (code.includes(key.slice(key.lastIndexOf(".") + 1))) {
        mentionsDefine = true;
        break;
      }
    }
  } else {
    mentionsDefine = dottedDefinePattern(defines)?.test(code) ?? false;
  }
  if (!mentionsDefine) return null;

  let program: ESTree.Program;
  try {
    program = parseProgram(code, { lang });
  } catch {
    return null;
  }

  const deadRanges: Array<{ start: number; end: number }> = [];
  const blankedRanges: Array<{ start: number; end: number }> = [];
  const within = (ranges: typeof deadRanges, node: ESTree.Node) =>
    ranges.some((range) => range.start <= node.start && node.end <= range.end);

  walkAstScopes(program, (node, scope) => {
    if (node.type === "CallExpression") {
      if (
        isIdentifierNamed(unwrapExpression(node.callee), "require") &&
        node.arguments.length > 0 &&
        within(deadRanges, node) &&
        !within(blankedRanges, node)
      ) {
        blankedRanges.push(node);
      }
      return;
    }
    const branch = deadBranch(node, scope, defines);
    if (branch) deadRanges.push(branch);
  });
  if (blankedRanges.length === 0) return null;

  const output = new MagicString(code);
  for (const { start, end } of blankedRanges) {
    const padding = code
      .slice(start + DEAD_REQUIRE_REPLACEMENT.length, end)
      .replace(/[^\n\r\u2028\u2029]/g, " ");
    output.overwrite(start, end, DEAD_REQUIRE_REPLACEMENT + padding);
  }
  return output;
}
