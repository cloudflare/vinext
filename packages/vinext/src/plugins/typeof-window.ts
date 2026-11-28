import path from "pathslash";
import { parseSync, type ESTree } from "vite";
import MagicString from "magic-string";
import {
  booleanLiteralValue,
  collectBindingNames,
  DYNAMIC_IMPORT_PRESCAN,
  forEachAstChild,
  isIdentifierNamed,
  stringLiteralValue,
} from "./ast-utils.js";
import {
  collectDirectScopeBindings,
  collectLoopScopeBindings,
  collectSwitchScopeBindings,
  collectVarScopeBindings,
  createAstScope,
  hasAstBinding,
  isFunctionNode,
  type AstScope,
} from "./ast-scope.js";
import { magicStringTransformResult } from "./transform-result.js";
import { stripViteModuleQuery } from "../utils/path.js";

type WindowType = "object" | "undefined";

const sourceEscapePattern = /\\(?:\r\n|[\n\r\u2028\u2029]|[^\n\r\u2028\u2029])/;
const identifierEscapePattern = /\\(?:u(?:[\da-fA-F]{4}|\{[\da-fA-F]+\})|x[\da-fA-F]{2})/;

// Match the local member syntax instead of bridging arbitrary source between
// `process` and `browser`. The latter restarts at every token and is quadratic.
// A comment after `process` or member punctuation is enough to admit the file;
// the scope-aware AST pass below remains the precise gate.
export const consumerEnvironmentConditionFilter = new RegExp(
  String.raw`\btypeof\s+window\b|${identifierEscapePattern.source}|\bprocess\b[\s)]*(?:(?:\?\.|\.)\s*(?:browser\b|\/[/*])|(?:\?\.\s*)?\[[\s(]*(?:["']browser["']|["'][^"'\\\n\r]*\\|\/[/*])|\/[/*])`,
);

// An import-scan build reduces every module to its import specifiers, and
// static import declarations cannot sit inside a foldable branch. Folding can
// therefore only change the scanned graph by pruning a dynamic `import()`, a
// phase import (`import.source()` / `import.defer()`), or an `import.meta`
// expression such as `import.meta.glob(...)`. Only those follow `import.`, so
// the dot alone admits them, including when a comment precedes the property.
const SCANNED_IMPORT_FOLD_PRESCAN = new RegExp(
  String.raw`${DYNAMIC_IMPORT_PRESCAN.source}|\bimport\s*\.`,
);
// `import.meta.url` and `import.meta.env` reads never name another module.
const NON_IMPORTING_IMPORT_META_RE = /\s*\.\s*(?:url|env)\b/y;

export type ConsumerEnvironmentReplacements = {
  typeofWindow?: WindowType;
  processBrowser?: boolean;
  /**
   * Compile-time `process.env.NEXT_RUNTIME` value (`""` for client bundles,
   * `"nodejs"` for server bundles). Folding its comparisons before
   * vite-plugin-commonjs hoists `require()` calls keeps requires in dead
   * runtime branches out of the module graph, as webpack's DefinePlugin does.
   */
  nextRuntime?: string;
  pruneUnreachableImports?: boolean;
  /**
   * Return null without walking the AST when folding cannot change the module's
   * scanned imports. Only valid for import-scan builds.
   */
  onlyIfScannedImportsChange?: boolean;
};

type EnvironmentLike = {
  config: {
    consumer: "client" | "server";
  };
};

function createChildScope(node: ESTree.Node, parent: AstScope): AstScope | null {
  if (
    node.type !== "Program" &&
    node.type !== "BlockStatement" &&
    node.type !== "StaticBlock" &&
    node.type !== "TSModuleBlock" &&
    node.type !== "CatchClause" &&
    node.type !== "ForStatement" &&
    node.type !== "ForInStatement" &&
    node.type !== "ForOfStatement" &&
    node.type !== "ClassDeclaration" &&
    node.type !== "ClassExpression"
  ) {
    return null;
  }

  const scope = createAstScope(parent);
  if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
    collectBindingNames(node.id, scope.bindings);
  } else if (node.type === "CatchClause") {
    collectBindingNames(node.param, scope.bindings);
  }
  collectDirectScopeBindings(node, scope);
  if (node.type === "StaticBlock" || node.type === "TSModuleBlock") {
    collectVarScopeBindings(node, scope);
  }
  if (
    node.type === "ForStatement" ||
    node.type === "ForInStatement" ||
    node.type === "ForOfStatement"
  ) {
    collectLoopScopeBindings(node, scope);
  }
  return scope;
}

export function getTypeofWindowReplacement(environment: EnvironmentLike): WindowType {
  return environment.config.consumer === "client" ? "object" : "undefined";
}

function evaluateTypeofWindowComparison(
  node: ESTree.Node,
  replacement: WindowType,
  scope: AstScope,
): boolean | null {
  if (node.type !== "BinaryExpression") return null;
  if (!["==", "===", "!=", "!=="].includes(String(node.operator))) return null;

  const { left, right } = node;
  const leftIsTypeofWindow =
    left?.type === "UnaryExpression" &&
    left.operator === "typeof" &&
    isIdentifierNamed(left.argument, "window") &&
    !hasAstBinding(scope, "window");
  const rightIsTypeofWindow =
    right?.type === "UnaryExpression" &&
    right.operator === "typeof" &&
    isIdentifierNamed(right.argument, "window") &&
    !hasAstBinding(scope, "window");

  const comparedValue = leftIsTypeofWindow
    ? stringLiteralValue(right)
    : rightIsTypeofWindow
      ? stringLiteralValue(left)
      : null;
  if (comparedValue === null) return null;

  const equal = replacement === comparedValue;
  return node.operator === "==" || node.operator === "===" ? equal : !equal;
}

function isProcessBrowserMember(node: ESTree.Node, scope: AstScope): boolean {
  const candidate = node.type === "ChainExpression" ? node.expression : node;
  if (candidate.type !== "MemberExpression") {
    return false;
  }
  return (
    isIdentifierNamed(candidate.object, "process") &&
    (candidate.computed
      ? stringLiteralValue(candidate.property) === "browser"
      : isIdentifierNamed(candidate.property, "browser")) &&
    !hasAstBinding(scope, "process")
  );
}

function evaluateProcessBrowserCondition(
  node: ESTree.Node,
  replacement: boolean,
  scope: AstScope,
): boolean | null {
  if (isProcessBrowserMember(node, scope)) return replacement;
  if (node.type === "UnaryExpression" && node.operator === "!") {
    const value = evaluateProcessBrowserCondition(node.argument, replacement, scope);
    return value === null ? null : !value;
  }
  if (node.type !== "BinaryExpression") return null;
  if (!["==", "===", "!=", "!=="].includes(String(node.operator))) return null;

  const leftIsProcessBrowser = isProcessBrowserMember(node.left, scope);
  const rightIsProcessBrowser = isProcessBrowserMember(node.right, scope);
  const comparedValue = leftIsProcessBrowser
    ? booleanLiteralValue(node.right)
    : rightIsProcessBrowser
      ? booleanLiteralValue(node.left)
      : null;
  if (comparedValue === null) return null;

  const equal = replacement === comparedValue;
  return node.operator === "==" || node.operator === "===" ? equal : !equal;
}

function isNextRuntimeMember(node: ESTree.Node, scope: AstScope): boolean {
  const candidate = node.type === "ChainExpression" ? node.expression : node;
  if (candidate.type !== "MemberExpression") return false;
  const env =
    candidate.object.type === "ChainExpression" ? candidate.object.expression : candidate.object;
  if (env.type !== "MemberExpression") return false;
  return (
    (candidate.computed
      ? stringLiteralValue(candidate.property) === "NEXT_RUNTIME"
      : isIdentifierNamed(candidate.property, "NEXT_RUNTIME")) &&
    (env.computed
      ? stringLiteralValue(env.property) === "env"
      : isIdentifierNamed(env.property, "env")) &&
    isIdentifierNamed(env.object, "process") &&
    !hasAstBinding(scope, "process")
  );
}

function evaluateNextRuntimeComparison(
  node: ESTree.Node,
  replacement: string,
  scope: AstScope,
  isTest: boolean,
): boolean | null {
  // A bare read is truthy unless the inlined value is "" (the client). Only
  // a test observes just its truthiness; elsewhere it yields the string.
  if (isNextRuntimeMember(node, scope)) return isTest ? replacement !== "" : null;
  if (node.type === "UnaryExpression" && node.operator === "!") {
    const value = evaluateNextRuntimeComparison(node.argument, replacement, scope, true);
    return value === null ? null : !value;
  }
  if (node.type !== "BinaryExpression") return null;
  if (!["==", "===", "!=", "!=="].includes(String(node.operator))) return null;

  const comparedValue = isNextRuntimeMember(node.left, scope)
    ? stringLiteralValue(node.right)
    : isNextRuntimeMember(node.right, scope)
      ? stringLiteralValue(node.left)
      : null;
  if (comparedValue === null) return null;

  const equal = replacement === comparedValue;
  return node.operator === "==" || node.operator === "===" ? equal : !equal;
}

type EvaluatedCondition = {
  value: boolean;
  effects: ESTree.Node[];
  /** Whether an environment condition decided the value, not only literals. */
  environment: boolean;
};

function combineConditions(
  left: EvaluatedCondition,
  right: EvaluatedCondition,
): EvaluatedCondition {
  return {
    value: right.value,
    effects: [...left.effects, ...right.effects],
    environment: left.environment || right.environment,
  };
}

/**
 * Evaluates `node` when the consumer environment decides it. `isTest` is true
 * where only the result's truthiness is observed (an `if` or ternary test,
 * and the `&&`/`||` operands within one).
 */
function evaluateConsumerCondition(
  node: ESTree.Node,
  replacements: ConsumerEnvironmentReplacements,
  scope: AstScope,
  isTest: boolean,
): EvaluatedCondition | null {
  if (node.type === "LogicalExpression") {
    const left = evaluateConsumerCondition(node.left, replacements, scope, isTest);
    if (node.operator === "&&") {
      if (left?.value === false) return left;
      if (left?.value === true) {
        const right = evaluateConsumerCondition(node.right, replacements, scope, isTest);
        return right ? combineConditions(left, right) : null;
      }
      const right = evaluateConsumerCondition(node.right, replacements, scope, isTest);
      if (
        replacements.pruneUnreachableImports &&
        right?.value === false &&
        right.environment &&
        right.effects.length === 0
      ) {
        return { value: false, effects: [node.left], environment: true };
      }
    } else if (node.operator === "||") {
      if (left?.value === true) return left;
      if (left?.value === false) {
        const right = evaluateConsumerCondition(node.right, replacements, scope, isTest);
        return right ? combineConditions(left, right) : null;
      }
      const right = evaluateConsumerCondition(node.right, replacements, scope, isTest);
      if (
        replacements.pruneUnreachableImports &&
        right?.value === true &&
        right.environment &&
        right.effects.length === 0
      ) {
        return { value: true, effects: [node.left], environment: true };
      }
    } else if (node.operator === "??" && left !== null) {
      return left;
    }
    return null;
  }
  if (node.type === "Literal" && typeof node.value === "boolean") {
    return { value: node.value, effects: [], environment: false };
  }
  if (replacements.typeofWindow !== undefined) {
    const result = evaluateTypeofWindowComparison(node, replacements.typeofWindow, scope);
    if (result !== null) return { value: result, effects: [], environment: true };
  }
  if (replacements.nextRuntime !== undefined) {
    const result = evaluateNextRuntimeComparison(node, replacements.nextRuntime, scope, isTest);
    if (result !== null) return { value: result, effects: [], environment: true };
  }
  if (replacements.processBrowser === undefined) return null;
  const result = evaluateProcessBrowserCondition(node, replacements.processBrowser, scope);
  return result === null ? null : { value: result, effects: [], environment: true };
}

/** A `var` declaration of the bindings a discarded branch hoists, or "". */
function hoistedVarDeclaration(discarded: ESTree.Node | null | undefined): string {
  if (!discarded) return "";
  const scope = createAstScope(null);
  collectVarScopeBindings(discarded, scope, false);
  return scope.bindings.size === 0 ? "" : `var ${[...scope.bindings].join(", ")}; `;
}

/** Like {@link evaluateConsumerCondition}, but only results the environment decided. */
function evaluateEnvironmentCondition(
  node: ESTree.Node,
  replacements: ConsumerEnvironmentReplacements,
  scope: AstScope,
  isTest: boolean,
): EvaluatedCondition | null {
  const result = evaluateConsumerCondition(node, replacements, scope, isTest);
  return result?.environment ? result : null;
}

/**
 * Cheap pre-parse gate for import-scan builds. Over-inclusive by design; the
 * parser's module record in {@link moduleRecordHasScannedFoldTargets} is exact.
 */
export function mayFoldChangeScannedImports(code: string): boolean {
  return SCANNED_IMPORT_FOLD_PRESCAN.test(code);
}

/**
 * Whether folding may change a scanned import: any dynamic or phase import, or
 * an `import.meta` expression other than a `.url`/`.env` read. Reads the parser's native module record, so no
 * ESTree is materialized.
 */
function moduleRecordHasScannedFoldTargets(
  code: string,
  module: ReturnType<typeof parseSync>["module"],
  lang: "js" | "jsx" | "ts" | "tsx",
): boolean {
  // The module record omits TypeScript `import("x")` types, which the scan's
  // lexer still sees when no earlier plugin stripped them.
  if ((lang === "ts" || lang === "tsx") && DYNAMIC_IMPORT_PRESCAN.test(code)) return true;
  // Any dynamic or phase import counts: besides static specifiers, folding can
  // turn a request such as `import(typeof window)` into a literal.
  if (module.dynamicImports.length > 0) return true;
  for (const importMeta of module.importMetas) {
    NON_IMPORTING_IMPORT_META_RE.lastIndex = importMeta.end;
    if (!NON_IMPORTING_IMPORT_META_RE.test(code)) return true;
  }
  return false;
}

export function replaceTypeofWindow(code: string, replacement: WindowType, id = "file.js") {
  return replaceConsumerEnvironmentConditions(code, { typeofWindow: replacement }, id);
}

export function replaceConsumerEnvironmentConditions(
  code: string,
  replacements: ConsumerEnvironmentReplacements,
  id = "file.js",
) {
  const mayContainTypeofWindow =
    replacements.typeofWindow !== undefined && /typeof\s+window/.test(code);
  const mayContainProcessBrowser =
    replacements.processBrowser !== undefined &&
    ((/\bprocess\b/.test(code) && /\bbrowser\b/.test(code)) || sourceEscapePattern.test(code));
  const mayContainNextRuntime =
    replacements.nextRuntime !== undefined && /\bNEXT_RUNTIME\b/.test(code);
  if (!mayContainTypeofWindow && !mayContainProcessBrowser && !mayContainNextRuntime) return null;

  const extension = path.extname(stripViteModuleQuery(id));
  const lang =
    extension === ".ts" || extension === ".mts" || extension === ".cts"
      ? "ts"
      : extension === ".tsx"
        ? "tsx"
        : extension === ".jsx"
          ? "jsx"
          : "js";
  const parsed = parseSync(id, code, { lang, preserveParens: false });
  if (parsed.errors.length > 0) return null;
  if (
    replacements.onlyIfScannedImportsChange &&
    !moduleRecordHasScannedFoldTargets(code, parsed.module, lang)
  ) {
    return null;
  }
  const ast = parsed.program;

  const output = new MagicString(code);
  let changed = false;

  function overwriteGap(start: number, end: number, content: string): void {
    if (start === end) {
      output.appendLeft(start, content);
    } else {
      output.overwrite(start, end, content);
    }
  }

  const rootScope = createAstScope(null);
  collectDirectScopeBindings(ast, rootScope);
  collectVarScopeBindings(ast, rootScope);

  function visit(node: ESTree.Node, parentScope: AstScope): void {
    if (isFunctionNode(node)) {
      const parameterScope = createAstScope(parentScope);
      collectBindingNames(node.id, parameterScope.bindings);
      for (const parameter of node.params) {
        collectBindingNames(parameter, parameterScope.bindings);
        visit(parameter, parameterScope);
      }

      if (!node.body) return;
      if (node.body.type === "BlockStatement") {
        const bodyScope = createAstScope(parameterScope);
        collectDirectScopeBindings(node.body, bodyScope);
        collectVarScopeBindings(node.body, bodyScope);
        visit(node.body, bodyScope);
      } else {
        visit(node.body, parameterScope);
      }
      return;
    }

    if (node.type === "SwitchStatement") {
      visit(node.discriminant, parentScope);
      const switchScope = createAstScope(parentScope);
      collectSwitchScopeBindings(node, switchScope);
      for (const switchCase of node.cases) visit(switchCase, switchScope);
      return;
    }

    const scope = createChildScope(node, parentScope) ?? parentScope;

    if (node.type === "IfStatement") {
      const result = evaluateEnvironmentCondition(node.test, replacements, scope, true);
      if (result !== null) {
        const selected = result.value ? node.consequent : node.alternate;
        // A discarded branch's `var` bindings are hoisted out of it, so they
        // stay declared.
        const hoisted = hoistedVarDeclaration(result.value ? node.alternate : node.consequent);
        if (result.effects.length > 0) {
          const effects = result.effects;
          for (const effect of effects) visit(effect, scope);
          if (selected) visit(selected, scope);
          overwriteGap(node.start, effects[0].start, `{ ${hoisted}(`);
          for (let index = 1; index < effects.length; index++) {
            overwriteGap(effects[index - 1].end, effects[index].start, "); (");
          }
          const lastEffect = effects.at(-1)!;
          if (selected) {
            overwriteGap(lastEffect.end, selected.start, "); ");
            overwriteGap(selected.end, node.end, " }");
          } else {
            overwriteGap(lastEffect.end, node.end, "); }");
          }
        } else if (selected?.type === "BlockStatement" && hoisted === "") {
          output.remove(node.start, selected.start);
          output.remove(selected.end, node.end);
          visit(selected, scope);
        } else if (selected) {
          // A block keeps a selected statement such as a string expression
          // out of its parent's directive prologue. The selected branch is
          // folded first, so the closing brace outlasts its own edits.
          visit(selected, scope);
          overwriteGap(node.start, selected.start, `{ ${hoisted}`);
          overwriteGap(selected.end, node.end, " }");
        } else {
          output.overwrite(node.start, node.end, hoisted === "" ? ";" : hoisted.trimEnd());
        }
        changed = true;
        return;
      }
    }

    if (node.type === "ConditionalExpression") {
      const result = evaluateEnvironmentCondition(node.test, replacements, scope, true);
      const selected = result?.value ? node.consequent : node.alternate;
      if (result !== null) {
        if (result.effects.length > 0) {
          const effects = result.effects;
          for (const effect of effects) visit(effect, scope);
          visit(selected, scope);
          overwriteGap(node.start, effects[0].start, "((");
          for (let index = 1; index < effects.length; index++) {
            overwriteGap(effects[index - 1].end, effects[index].start, "), (");
          }
          overwriteGap(effects.at(-1)!.end, selected.start, "), (");
          overwriteGap(selected.end, node.end, "))");
        } else {
          output.overwrite(node.start, selected.start, "(");
          if (selected.end < node.end) {
            output.overwrite(selected.end, node.end, ")");
          } else {
            output.appendLeft(selected.end, ")");
          }
          visit(selected, scope);
        }
        changed = true;
        return;
      }
    }

    if (node.type === "LogicalExpression") {
      const result = evaluateEnvironmentCondition(node, replacements, scope, false);
      if (result !== null) {
        const effects = result.effects;
        if (effects.length > 0) {
          for (const effect of effects) visit(effect, scope);
          overwriteGap(node.start, effects[0].start, "((");
          for (let index = 1; index < effects.length; index++) {
            overwriteGap(effects[index - 1].end, effects[index].start, "), (");
          }
          overwriteGap(effects.at(-1)!.end, node.end, `), ${String(result.value)})`);
        } else {
          output.overwrite(node.start, node.end, String(result.value));
        }
        changed = true;
        return;
      }
    }

    if (
      node.type === "UnaryExpression" &&
      node.operator === "typeof" &&
      isIdentifierNamed(node.argument, "window") &&
      replacements.typeofWindow !== undefined &&
      !hasAstBinding(scope, "window")
    ) {
      output.overwrite(node.start, node.end, JSON.stringify(replacements.typeofWindow));
      changed = true;
      return;
    }

    if (replacements.processBrowser !== undefined && isProcessBrowserMember(node, scope)) {
      output.overwrite(node.start, node.end, String(replacements.processBrowser));
      changed = true;
      return;
    }

    forEachAstChild(node, (child) => visit(child, scope));
  }

  for (const node of ast.body) visit(node, rootScope);
  if (!changed) return null;

  return magicStringTransformResult(output);
}
