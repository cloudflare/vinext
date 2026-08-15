import path from "pathslash";
import { parseAst } from "vite";
import MagicString from "magic-string";
import {
  collectBindingNames,
  forEachAstChild,
  hasRange,
  isAstRecord,
  isIdentifierNamed,
  nodeArray,
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

type AstNode = Parameters<typeof forEachAstChild>[0];

type EnvironmentLike = {
  config: {
    consumer: "client" | "server";
  };
};

function createChildScope(node: AstNode, parent: AstScope): AstScope | null {
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

function stringLiteralValue(node: unknown): string | null {
  if (!isAstRecord(node)) return null;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  return null;
}

function evaluateTypeofWindowComparison(
  node: unknown,
  replacement: WindowType,
  scope: AstScope,
): boolean | null {
  if (!isAstRecord(node) || node.type !== "BinaryExpression") return null;
  if (!["==", "===", "!=", "!=="].includes(String(node.operator))) return null;

  const left = isAstRecord(node.left) ? node.left : null;
  const right = isAstRecord(node.right) ? node.right : null;
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

function isProcessBrowserMember(node: unknown, scope: AstScope): boolean {
  const candidate =
    isAstRecord(node) && node.type === "ChainExpression" && isAstRecord(node.expression)
      ? node.expression
      : node;
  if (!isAstRecord(candidate) || candidate.type !== "MemberExpression") {
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

function booleanLiteralValue(node: unknown): boolean | null {
  if (!isAstRecord(node) || node.type !== "Literal" || typeof node.value !== "boolean") {
    return null;
  }
  return node.value;
}

function evaluateProcessBrowserCondition(
  node: unknown,
  replacement: boolean,
  scope: AstScope,
): boolean | null {
  if (isProcessBrowserMember(node, scope)) return replacement;
  if (isAstRecord(node) && node.type === "UnaryExpression" && node.operator === "!") {
    const value = evaluateProcessBrowserCondition(node.argument, replacement, scope);
    return value === null ? null : !value;
  }
  if (!isAstRecord(node) || node.type !== "BinaryExpression") return null;
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
  effects: AstNode[];
};

function evaluateConsumerCondition(
  node: unknown,
  replacements: ConsumerEnvironmentReplacements,
  scope: AstScope,
): EvaluatedCondition | null {
  if (isAstRecord(node) && node.type === "LogicalExpression") {
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
        right.effects.length === 0 &&
        isAstRecord(node.left)
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
        right.effects.length === 0 &&
        isAstRecord(node.left)
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

  const extension = path.extname(id.split("?", 1)[0]);
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
  if (!isAstRecord(ast)) return null;

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

  function visit(node: AstNode, parentScope: AstScope): void {
    if (isFunctionNode(node)) {
      const parameterScope = createAstScope(parentScope);
      collectBindingNames(node.id, parameterScope.bindings);
      for (const parameter of nodeArray(node.params)) {
        collectBindingNames(parameter, parameterScope.bindings);
        if (isAstRecord(parameter)) visit(parameter, parameterScope);
      }

      if (isAstRecord(node.body)) {
        if (node.body.type === "BlockStatement") {
          const bodyScope = createAstScope(parameterScope);
          collectDirectScopeBindings(node.body, bodyScope);
          collectVarScopeBindings(node.body, bodyScope);
          visit(node.body, bodyScope);
        } else {
          visit(node.body, parameterScope);
        }
      }
      return;
    }

    if (node.type === "SwitchStatement") {
      if (isAstRecord(node.discriminant)) visit(node.discriminant, parentScope);
      const switchScope = createAstScope(parentScope);
      collectSwitchScopeBindings(node, switchScope);
      for (const switchCase of nodeArray(node.cases)) {
        if (isAstRecord(switchCase)) visit(switchCase, switchScope);
      }
      return;
    }

    const scope = createChildScope(node, parentScope) ?? parentScope;

    if (node.type === "IfStatement" && hasRange(node)) {
      const result = evaluateConsumerCondition(node.test, replacements, scope);
      if (result !== null) {
        const selected = result.value ? node.consequent : node.alternate;
        if (result.effects.length > 0) {
          const effects = result.effects.filter(hasRange);
          for (const effect of effects) visit(effect, scope);
          if (isAstRecord(selected) && hasRange(selected)) visit(selected, scope);
          overwriteGap(node.start, effects[0].start, "{ (");
          for (let index = 1; index < effects.length; index++) {
            overwriteGap(effects[index - 1].end, effects[index].start, "); (");
          }
          const lastEffect = effects.at(-1)!;
          if (isAstRecord(selected) && hasRange(selected)) {
            overwriteGap(lastEffect.end, selected.start, "); ");
            overwriteGap(selected.end, node.end, " }");
          } else {
            overwriteGap(lastEffect.end, node.end, "); }");
          }
        } else if (isAstRecord(selected) && hasRange(selected)) {
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

    if (node.type === "ConditionalExpression" && hasRange(node)) {
      const result = evaluateConsumerCondition(node.test, replacements, scope);
      const selected = result?.value ? node.consequent : node.alternate;
      if (result !== null && isAstRecord(selected) && hasRange(selected)) {
        if (result.effects.length > 0) {
          const effects = result.effects.filter(hasRange);
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

    if (node.type === "LogicalExpression" && hasRange(node)) {
      const result = evaluateConsumerCondition(node, replacements, scope);
      if (result !== null) {
        const effects = result.effects.filter(hasRange);
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
      !hasAstBinding(scope, "window") &&
      hasRange(node)
    ) {
      output.overwrite(node.start, node.end, JSON.stringify(replacements.typeofWindow));
      changed = true;
      return;
    }

    if (
      replacements.processBrowser !== undefined &&
      isProcessBrowserMember(node, scope) &&
      hasRange(node)
    ) {
      output.overwrite(node.start, node.end, String(replacements.processBrowser));
      changed = true;
      return;
    }

    forEachAstChild(node, (child) => visit(child, scope));
  }

  for (const node of ast.body) {
    if (isAstRecord(node)) visit(node, rootScope);
  }
  if (!changed) return null;

  return {
    code: output.toString(),
    map: output.generateMap({ hires: "boundary" }),
  };
}
