import path from "node:path";
import { fileURLToPath } from "node:url";
import MagicString from "magic-string";
import { parseAst, type Plugin } from "vite";
import {
  collectBindingNames,
  forEachAstChild,
  hasRange,
  isAstRecord,
  isIdentifierNamed,
  nodeArray,
  type AstRecord,
} from "./ast-utils.js";

const DYNAMIC_REQUEST_ERROR = "Cannot find module as expression is too dynamic";
const VINEXT_SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TRANSFORMABLE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
]);
const TRANSPARENT_EXPRESSIONS = new Set([
  "ChainExpression",
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSInstantiationExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
]);

type Scope = {
  parent: Scope | null;
  bindings: Set<string>;
};

function astNode(value: unknown): AstRecord | null {
  return isAstRecord(value) ? value : null;
}

function unwrapExpression(value: unknown): AstRecord | null {
  const node = astNode(value);
  if (!node || !TRANSPARENT_EXPRESSIONS.has(node.type)) return node;
  return unwrapExpression(node.expression);
}

function stringValue(node: AstRecord): string | null {
  if (
    (node.type === "Literal" || node.type === "StringLiteral") &&
    typeof node.value === "string"
  ) {
    return node.value;
  }
  return null;
}

function hasSignificantPathPart(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  return normalized !== "" && normalized !== "/";
}

function templateHasStaticPart(node: AstRecord): boolean {
  const quasis = nodeArray(node.quasis).filter(isAstRecord);
  if (nodeArray(node.expressions).length === 0) return true;
  return quasis.some((quasi) => {
    const value = quasi.value;
    const cooked =
      typeof value === "object" && value !== null ? Reflect.get(value, "cooked") : null;
    const raw = typeof value === "object" && value !== null ? Reflect.get(value, "raw") : null;
    return hasSignificantPathPart(
      typeof cooked === "string" ? cooked : typeof raw === "string" ? raw : "",
    );
  });
}

function staticTruthiness(value: unknown, scope: Scope): boolean | null {
  const node = unwrapExpression(value);
  if (!node) return null;
  if (node.type === "Literal" || node.type === "StringLiteral") return Boolean(node.value);
  if (isIdentifierNamed(node, "undefined") && !hasBinding(scope, "undefined")) return false;
  if (
    node.type === "ArrayExpression" ||
    node.type === "ObjectExpression" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression" ||
    node.type === "ClassExpression"
  ) {
    return true;
  }
  return null;
}

function staticNullishness(value: unknown, scope: Scope): boolean | null {
  const node = unwrapExpression(value);
  if (!node) return null;
  if (node.type === "Literal" || node.type === "StringLiteral") return node.value === null;
  if (isIdentifierNamed(node, "undefined") && !hasBinding(scope, "undefined")) return true;
  if (
    node.type === "ArrayExpression" ||
    node.type === "ObjectExpression" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression" ||
    node.type === "ClassExpression" ||
    node.type === "TemplateLiteral"
  ) {
    return false;
  }
  return null;
}

function requestHasStaticPart(value: unknown, scope: Scope): boolean {
  const node = unwrapExpression(value);
  if (!node) return false;

  const constantString = stringValue(node);
  if (constantString !== null) return hasSignificantPathPart(constantString);
  if (node.type === "Literal") return true;
  if (node.type === "TemplateLiteral") return templateHasStaticPart(node);
  if (isIdentifierNamed(node, "undefined")) return !hasBinding(scope, "undefined");

  if (node.type === "BinaryExpression" && node.operator === "+") {
    const left = unwrapExpression(node.left);
    const right = unwrapExpression(node.right);
    const leftString = left ? stringValue(left) : null;
    const rightString = right ? stringValue(right) : null;
    return (
      (leftString !== null && hasSignificantPathPart(leftString)) ||
      (rightString !== null && hasSignificantPathPart(rightString)) ||
      requestHasStaticPart(left, scope) ||
      requestHasStaticPart(right, scope)
    );
  }

  if (node.type === "ConditionalExpression") {
    const truthiness = staticTruthiness(node.test, scope);
    return truthiness === null
      ? false
      : requestHasStaticPart(truthiness ? node.consequent : node.alternate, scope);
  }
  if (node.type === "LogicalExpression") {
    const truthiness = staticTruthiness(node.left, scope);
    if (node.operator === "&&" && truthiness !== null) {
      return requestHasStaticPart(truthiness ? node.right : node.left, scope);
    }
    if (node.operator === "||" && truthiness !== null) {
      return requestHasStaticPart(truthiness ? node.left : node.right, scope);
    }
    if (node.operator === "??") {
      const nullishness = staticNullishness(node.left, scope);
      if (nullishness !== null) {
        return requestHasStaticPart(nullishness ? node.right : node.left, scope);
      }
    }
    return requestHasStaticPart(node.left, scope) || requestHasStaticPart(node.right, scope);
  }
  if (node.type === "SequenceExpression") {
    const expressions = nodeArray(node.expressions);
    return expressions.length > 0 && requestHasStaticPart(expressions.at(-1), scope);
  }

  return false;
}

function isFunction(node: AstRecord): boolean {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

function collectDirectBindings(node: AstRecord, scope: Scope): void {
  for (const statementValue of nodeArray(node.body)) {
    const statement = astNode(statementValue);
    if (!statement) continue;
    const declaration =
      statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration"
        ? astNode(statement.declaration)
        : statement;
    if (!declaration) continue;

    if (declaration.type === "ImportDeclaration") {
      for (const specifier of nodeArray(declaration.specifiers)) {
        const specifierNode = astNode(specifier);
        if (specifierNode?.importKind !== "type")
          collectBindingNames(specifierNode?.local, scope.bindings);
      }
    } else if (declaration.type === "VariableDeclaration" && declaration.declare !== true) {
      for (const declarator of nodeArray(declaration.declarations)) {
        collectBindingNames(astNode(declarator)?.id, scope.bindings);
      }
    } else if (
      (declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration") &&
      declaration.declare !== true
    ) {
      collectBindingNames(declaration.id, scope.bindings);
    }
  }
}

function collectVarBindings(node: AstRecord, scope: Scope, root = true): void {
  if (!root && isFunction(node)) return;
  if (node.type === "VariableDeclaration" && node.kind === "var" && node.declare !== true) {
    for (const declarator of nodeArray(node.declarations)) {
      collectBindingNames(astNode(declarator)?.id, scope.bindings);
    }
  }
  forEachAstChild(node, (child) => collectVarBindings(child, scope, false));
}

function hasBinding(scope: Scope, name: string): boolean {
  for (let current: Scope | null = scope; current; current = current.parent) {
    if (current.bindings.has(name)) return true;
  }
  return false;
}

function dynamicRequireReplacement(): string {
  return `(() => { const error = new Error(${JSON.stringify(DYNAMIC_REQUEST_ERROR)}); error.code = "MODULE_NOT_FOUND"; throw error; })()`;
}

function dynamicImportReplacement(): string {
  return `Promise.resolve().then(() => { const error = new Error(${JSON.stringify(DYNAMIC_REQUEST_ERROR)}); error.code = "MODULE_NOT_FOUND"; throw error; })`;
}

function transformVeryDynamicRequests(code: string, id: string) {
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
  const root = astNode(ast);
  if (!root) return null;
  const rootScope: Scope = { parent: null, bindings: new Set() };
  collectDirectBindings(root, rootScope);
  collectVarBindings(root, rootScope);

  function visit(node: AstRecord, parentScope: Scope): void {
    let scope = parentScope;
    if (isFunction(node)) {
      scope = { parent: parentScope, bindings: new Set() };
      collectBindingNames(node.id, scope.bindings);
      for (const parameter of nodeArray(node.params))
        collectBindingNames(parameter, scope.bindings);
      const body = astNode(node.body);
      if (body) {
        collectDirectBindings(body, scope);
        collectVarBindings(body, scope);
      }
    } else if (node.type === "BlockStatement" && node !== root) {
      scope = { parent: parentScope, bindings: new Set() };
      collectDirectBindings(node, scope);
    } else if (node.type === "CatchClause") {
      scope = { parent: parentScope, bindings: new Set() };
      collectBindingNames(node.param, scope.bindings);
    }

    if (node.type === "CallExpression" && hasRange(node)) {
      const callee = unwrapExpression(node.callee);
      const argumentsList = nodeArray(node.arguments);
      if (
        isIdentifierNamed(callee, "require") &&
        !hasBinding(scope, "require") &&
        argumentsList.length === 1 &&
        astNode(argumentsList[0])?.type !== "SpreadElement" &&
        !requestHasStaticPart(argumentsList[0], scope)
      ) {
        output.overwrite(node.start, node.end, dynamicRequireReplacement());
        changed = true;
        return;
      }
    }

    if (
      node.type === "ImportExpression" &&
      hasRange(node) &&
      !requestHasStaticPart(node.source, scope)
    ) {
      output.overwrite(node.start, node.end, dynamicImportReplacement());
      changed = true;
      return;
    }

    forEachAstChild(node, (child) => visit(child, scope));
  }

  for (const statement of nodeArray(root.body)) {
    if (isAstRecord(statement)) visit(statement, rootScope);
  }

  if (!changed) return null;
  return {
    code: output.toString(),
    map: output.generateMap({ hires: "boundary", source: id }),
  };
}

export function createIgnoreDynamicRequestsPlugin(): Plugin {
  return {
    name: "vinext:ignore-dynamic-requests",
    enforce: "pre",
    transform: {
      filter: {
        id: {
          include: /\.[cm]?[jt]sx?(?:\?.*)?$/,
          exclude: /[\\/]node_modules[\\/]/,
        },
        code: /\b(?:require|import)\s*\(/,
      },
      handler(code, id) {
        const cleanId = id.split("?", 1)[0];
        if (!TRANSFORMABLE_EXTENSIONS.has(path.extname(cleanId))) return null;
        const absoluteId = path.resolve(cleanId);
        if (
          absoluteId === VINEXT_SOURCE_ROOT ||
          absoluteId.startsWith(`${VINEXT_SOURCE_ROOT}${path.sep}`)
        ) {
          return null;
        }
        return transformVeryDynamicRequests(code, id);
      },
    },
  };
}

export const _transformVeryDynamicRequests = transformVeryDynamicRequests;
