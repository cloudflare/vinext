import path from "pathslash";
import { parseAst, type ESTree } from "vite";
import MagicString from "magic-string";
import {
  booleanLiteralValue,
  collectBindingNames,
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

export type ConsumerEnvironmentReplacements = {
  typeofWindow?: WindowType;
  processBrowser?: boolean;
  pruneUnreachableImports?: boolean;
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

type EvaluatedCondition = {
  value: boolean;
  effects: ESTree.Node[];
};

function evaluateConsumerCondition(
  node: ESTree.Node,
  replacements: ConsumerEnvironmentReplacements,
  scope: AstScope,
): EvaluatedCondition | null {
  if (node.type === "LogicalExpression") {
    const left = evaluateConsumerCondition(node.left, replacements, scope);
    if (node.operator === "&&") {
      if (left?.value === false) return left;
      if (left?.value === true) {
        const right = evaluateConsumerCondition(node.right, replacements, scope);
        return right ? { value: right.value, effects: [...left.effects, ...right.effects] } : null;
      }
      const right = evaluateConsumerCondition(node.right, replacements, scope);
      if (
        replacements.pruneUnreachableImports &&
        right?.value === false &&
        right.effects.length === 0
      ) {
        return { value: false, effects: [node.left] };
      }
    } else if (node.operator === "||") {
      if (left?.value === true) return left;
      if (left?.value === false) {
        const right = evaluateConsumerCondition(node.right, replacements, scope);
        return right ? { value: right.value, effects: [...left.effects, ...right.effects] } : null;
      }
      const right = evaluateConsumerCondition(node.right, replacements, scope);
      if (
        replacements.pruneUnreachableImports &&
        right?.value === true &&
        right.effects.length === 0
      ) {
        return { value: true, effects: [node.left] };
      }
    } else if (node.operator === "??" && left !== null) {
      return left;
    }
    return null;
  }
  if (replacements.typeofWindow !== undefined) {
    const result = evaluateTypeofWindowComparison(node, replacements.typeofWindow, scope);
    if (result !== null) return { value: result, effects: [] };
  }
  if (replacements.processBrowser === undefined) return null;
  const result = evaluateProcessBrowserCondition(node, replacements.processBrowser, scope);
  return result === null ? null : { value: result, effects: [] };
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
  if (!mayContainTypeofWindow && !mayContainProcessBrowser) return null;

  const extension = path.extname(stripViteModuleQuery(id));
  const lang =
    extension === ".ts" || extension === ".mts" || extension === ".cts"
      ? "ts"
      : extension === ".tsx"
        ? "tsx"
        : extension === ".jsx"
          ? "jsx"
          : "js";
  let ast: ReturnType<typeof parseAst>;
  try {
    ast = parseAst(code, { lang });
  } catch {
    return null;
  }

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
      const result = evaluateConsumerCondition(node.test, replacements, scope);
      if (result !== null) {
        const selected = result.value ? node.consequent : node.alternate;
        if (result.effects.length > 0) {
          const effects = result.effects;
          for (const effect of effects) visit(effect, scope);
          if (selected) visit(selected, scope);
          overwriteGap(node.start, effects[0].start, "{ (");
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
        } else if (selected) {
          output.remove(node.start, selected.start);
          output.remove(selected.end, node.end);
          visit(selected, scope);
        } else {
          output.overwrite(node.start, node.end, ";");
        }
        changed = true;
        return;
      }
    }

    if (node.type === "ConditionalExpression") {
      const result = evaluateConsumerCondition(node.test, replacements, scope);
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
      const result = evaluateConsumerCondition(node, replacements, scope);
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
