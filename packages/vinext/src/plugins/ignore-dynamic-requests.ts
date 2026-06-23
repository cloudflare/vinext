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
import {
  collectDirectScopeBindings,
  collectLoopScopeBindings,
  collectSwitchScopeBindings,
  collectVarScopeBindings,
  hasAstBinding,
  isFunctionNode,
  type AstScope,
} from "./ast-scope.js";

const DYNAMIC_REQUEST_ERROR = "Cannot find module as expression is too dynamic";
const VINEXT_SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_RSC_PATH =
  /[\\/]node_modules[\\/](?:\.pnpm[\\/][^/\\]+[\\/]node_modules[\\/])?@vitejs[\\/]plugin-rsc[\\/]/;
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
  bindings: AstScope["bindings"];
  constants: Map<string, AstRecord>;
};

type EnvironmentLike = {
  config: {
    consumer: "client" | "server";
  };
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

function hasDynamicRequestIgnoreDirective(
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

function templateHasStaticPart(
  node: AstRecord,
  scope: Scope,
  resolvingBindings: Set<string>,
): boolean {
  const quasis = nodeArray(node.quasis).filter(isAstRecord);
  if (nodeArray(node.expressions).length === 0) {
    const value = quasis[0]?.value;
    const cooked =
      typeof value === "object" && value !== null ? Reflect.get(value, "cooked") : null;
    const raw = typeof value === "object" && value !== null ? Reflect.get(value, "raw") : null;
    const constant = typeof cooked === "string" ? cooked : typeof raw === "string" ? raw : "";
    return constant.replaceAll("\\", "/") !== "/";
  }
  if (
    quasis.some((quasi) => {
      const value = quasi.value;
      const cooked =
        typeof value === "object" && value !== null ? Reflect.get(value, "cooked") : null;
      const raw = typeof value === "object" && value !== null ? Reflect.get(value, "raw") : null;
      return hasSignificantPathPart(
        typeof cooked === "string" ? cooked : typeof raw === "string" ? raw : "",
      );
    })
  ) {
    return true;
  }

  return nodeArray(node.expressions).some((expression) => {
    const expressionNode = unwrapExpression(expression);
    if (!expressionNode) return false;
    return requestHasStaticPart(expressionNode, scope, resolvingBindings);
  });
}

function isStaticSafeExpression(
  value: unknown,
  scope: Scope,
  resolvingBindings = new Set<string>(),
): boolean {
  const node = unwrapExpression(value);
  if (!node) return false;
  if (node.type === "Literal" || node.type === "StringLiteral") return true;
  if (isIdentifierNamed(node, "undefined") && !hasAstBinding(scope, "undefined")) return true;
  if (node.type === "Identifier" && typeof node.name === "string") {
    if (resolvingBindings.has(node.name)) return false;
    const binding = findConstantBinding(scope, node.name);
    if (!binding) return false;
    const nextResolvingBindings = new Set(resolvingBindings);
    nextResolvingBindings.add(node.name);
    return isStaticSafeExpression(binding, scope, nextResolvingBindings);
  }
  if (node.type === "UnaryExpression") {
    return isStaticSafeExpression(node.argument, scope, resolvingBindings);
  }
  if (node.type === "TemplateLiteral") {
    return nodeArray(node.expressions).every((expression) =>
      isStaticSafeExpression(expression, scope, resolvingBindings),
    );
  }
  return false;
}

function staticTruthiness(
  value: unknown,
  scope: Scope,
  resolvingBindings = new Set<string>(),
): boolean | null {
  const node = unwrapExpression(value);
  if (!node) return null;
  if (node.type === "Literal" || node.type === "StringLiteral") return Boolean(node.value);
  if (isIdentifierNamed(node, "undefined") && !hasAstBinding(scope, "undefined")) return false;
  if (node.type === "Identifier" && typeof node.name === "string") {
    if (resolvingBindings.has(node.name)) return null;
    const binding = findConstantBinding(scope, node.name);
    if (!binding) return null;
    const nextResolvingBindings = new Set(resolvingBindings);
    nextResolvingBindings.add(node.name);
    return staticTruthiness(binding, scope, nextResolvingBindings);
  }
  if (node.type === "UnaryExpression") {
    if (node.operator === "void") {
      return isStaticSafeExpression(node.argument, scope, resolvingBindings) ? false : null;
    }
    if (node.operator === "!") {
      const argumentTruthiness = staticTruthiness(node.argument, scope, resolvingBindings);
      return argumentTruthiness === null ? null : !argumentTruthiness;
    }
  }
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

function staticNullishness(
  value: unknown,
  scope: Scope,
  resolvingBindings = new Set<string>(),
): boolean | null {
  const node = unwrapExpression(value);
  if (!node) return null;
  if (node.type === "Literal" || node.type === "StringLiteral") return node.value === null;
  if (isIdentifierNamed(node, "undefined") && !hasAstBinding(scope, "undefined")) return true;
  if (node.type === "Identifier" && typeof node.name === "string") {
    if (resolvingBindings.has(node.name)) return null;
    const binding = findConstantBinding(scope, node.name);
    if (!binding) return null;
    const nextResolvingBindings = new Set(resolvingBindings);
    nextResolvingBindings.add(node.name);
    return staticNullishness(binding, scope, nextResolvingBindings);
  }
  if (node.type === "UnaryExpression") {
    return node.operator === "void" &&
      isStaticSafeExpression(node.argument, scope, resolvingBindings)
      ? true
      : null;
  }
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

function findConstantBinding(scope: Scope, name: string): AstRecord | null {
  for (let current: Scope | null = scope; current; current = current.parent) {
    if (!current.bindings.has(name)) continue;
    return current.constants.get(name) ?? null;
  }
  return null;
}

function stringConcatHasStaticPart(
  node: AstRecord,
  scope: Scope,
  resolvingBindings: Set<string>,
): boolean | null {
  if (node.type !== "CallExpression") return null;
  const callee = unwrapExpression(node.callee);
  const property = callee?.type === "MemberExpression" ? unwrapExpression(callee.property) : null;
  if (
    callee?.type !== "MemberExpression" ||
    (callee.computed === true
      ? property === null || stringValue(property) !== "concat"
      : !isIdentifierNamed(property, "concat"))
  ) {
    return null;
  }

  const receiver = unwrapExpression(callee.object);
  if (!receiver || !isStaticStringExpression(receiver, scope, resolvingBindings)) return null;
  if (requestHasStaticPart(receiver, scope, resolvingBindings)) return true;

  return nodeArray(node.arguments).some((argument) => {
    const argumentNode = unwrapExpression(argument);
    return argumentNode ? requestHasStaticPart(argumentNode, scope, resolvingBindings) : false;
  });
}

function isStaticStringExpression(
  value: unknown,
  scope: Scope,
  resolvingBindings: Set<string>,
): boolean {
  const node = unwrapExpression(value);
  if (!node) return false;
  if (stringValue(node) !== null || node.type === "TemplateLiteral") return true;
  if (node.type === "Identifier" && typeof node.name === "string") {
    if (resolvingBindings.has(node.name)) return false;
    const binding = findConstantBinding(scope, node.name);
    if (!binding) return false;
    const nextResolvingBindings = new Set(resolvingBindings);
    nextResolvingBindings.add(node.name);
    return isStaticStringExpression(binding, scope, nextResolvingBindings);
  }
  return false;
}

function additionContainsString(
  value: unknown,
  scope: Scope,
  resolvingBindings: Set<string>,
): boolean {
  const node = unwrapExpression(value);
  if (!node) return false;
  if (stringValue(node) !== null || node.type === "TemplateLiteral") return true;
  if (node.type === "Identifier" && typeof node.name === "string") {
    if (resolvingBindings.has(node.name)) return false;
    const binding = findConstantBinding(scope, node.name);
    if (!binding) return false;
    const nextResolvingBindings = new Set(resolvingBindings);
    nextResolvingBindings.add(node.name);
    return additionContainsString(binding, scope, nextResolvingBindings);
  }
  if (node.type === "BinaryExpression" && node.operator === "+") {
    return (
      additionContainsString(node.left, scope, resolvingBindings) ||
      additionContainsString(node.right, scope, resolvingBindings)
    );
  }
  if (node.type === "ConditionalExpression") {
    return (
      additionContainsString(node.consequent, scope, resolvingBindings) &&
      additionContainsString(node.alternate, scope, resolvingBindings)
    );
  }
  if (node.type === "SequenceExpression") {
    return additionContainsString(nodeArray(node.expressions).at(-1), scope, resolvingBindings);
  }
  return stringConcatHasStaticPart(node, scope, resolvingBindings) !== null;
}

function requestHasStaticPart(
  value: unknown,
  scope: Scope,
  resolvingBindings = new Set<string>(),
): boolean {
  const node = unwrapExpression(value);
  if (!node) return false;

  const constantString = stringValue(node);
  if (constantString !== null) return constantString.replaceAll("\\", "/") !== "/";
  if (node.type === "Literal") return true;
  if (node.type === "TemplateLiteral") {
    return templateHasStaticPart(node, scope, resolvingBindings);
  }
  const concatHasStaticPart = stringConcatHasStaticPart(node, scope, resolvingBindings);
  if (concatHasStaticPart !== null) return concatHasStaticPart;
  if (isIdentifierNamed(node, "undefined")) return !hasAstBinding(scope, "undefined");
  if (node.type === "Identifier" && typeof node.name === "string") {
    if (resolvingBindings.has(node.name)) return false;
    const binding = findConstantBinding(scope, node.name);
    if (!binding) return false;
    const nextResolvingBindings = new Set(resolvingBindings);
    nextResolvingBindings.add(node.name);
    return requestHasStaticPart(binding, scope, nextResolvingBindings);
  }
  if (node.type === "UnaryExpression") {
    if (node.operator === "void") {
      return isStaticSafeExpression(node.argument, scope, resolvingBindings);
    }
    if (node.operator === "!") return true;
    return staticTruthiness(node, scope, resolvingBindings) !== null;
  }

  if (node.type === "BinaryExpression" && node.operator === "+") {
    if (!additionContainsString(node, scope, resolvingBindings)) return false;
    const left = unwrapExpression(node.left);
    const right = unwrapExpression(node.right);
    const leftString = left ? stringValue(left) : null;
    const rightString = right ? stringValue(right) : null;
    return (
      (leftString !== null && hasSignificantPathPart(leftString)) ||
      (rightString !== null && hasSignificantPathPart(rightString)) ||
      (leftString === null && requestHasStaticPart(left, scope, resolvingBindings)) ||
      (rightString === null && requestHasStaticPart(right, scope, resolvingBindings))
    );
  }

  if (node.type === "ConditionalExpression") {
    const truthiness = staticTruthiness(node.test, scope, resolvingBindings);
    return truthiness === null
      ? requestHasStaticPart(node.consequent, scope, resolvingBindings) ||
          requestHasStaticPart(node.alternate, scope, resolvingBindings)
      : requestHasStaticPart(
          truthiness ? node.consequent : node.alternate,
          scope,
          resolvingBindings,
        );
  }
  if (node.type === "LogicalExpression") {
    const truthiness = staticTruthiness(node.left, scope, resolvingBindings);
    if (node.operator === "&&" && truthiness !== null) {
      return requestHasStaticPart(truthiness ? node.right : node.left, scope, resolvingBindings);
    }
    if (node.operator === "||" && truthiness !== null) {
      return requestHasStaticPart(truthiness ? node.left : node.right, scope, resolvingBindings);
    }
    if (node.operator === "??") {
      const nullishness = staticNullishness(node.left, scope, resolvingBindings);
      if (nullishness !== null) {
        return requestHasStaticPart(nullishness ? node.right : node.left, scope, resolvingBindings);
      }
    }
    return (
      requestHasStaticPart(node.left, scope, resolvingBindings) ||
      requestHasStaticPart(node.right, scope, resolvingBindings)
    );
  }
  if (node.type === "SequenceExpression") {
    const expressions = nodeArray(node.expressions);
    return (
      expressions.length > 0 && requestHasStaticPart(expressions.at(-1), scope, resolvingBindings)
    );
  }

  return false;
}

function collectConstantBinding(declaration: AstRecord, declarator: AstRecord, scope: Scope): void {
  const identifier = astNode(declarator.id);
  const initializer = astNode(declarator.init);
  if (
    declaration.kind === "const" &&
    identifier?.type === "Identifier" &&
    typeof identifier.name === "string" &&
    initializer
  ) {
    scope.constants.set(identifier.name, initializer);
  }
}

function collectDirectBindings(node: AstRecord, scope: Scope): void {
  collectDirectScopeBindings(node, scope, (declaration, declarator) =>
    collectConstantBinding(declaration, declarator, scope),
  );

  if (node.type === "SwitchStatement") {
    collectSwitchScopeBindings(node, scope, (declaration, declarator) =>
      collectConstantBinding(declaration, declarator, scope),
    );
  }
}

function dynamicRequireReplacement(): string {
  return `(() => { const error = new Error(${JSON.stringify(DYNAMIC_REQUEST_ERROR)}); error.code = "MODULE_NOT_FOUND"; throw error; })()`;
}

function dynamicImportReplacement(): string {
  return `Promise.resolve().then(() => { const error = new Error(${JSON.stringify(DYNAMIC_REQUEST_ERROR)}); error.code = "MODULE_NOT_FOUND"; throw error; })`;
}

function transformVeryDynamicRequests(code: string, id: string) {
  if (!code.includes("require") && !code.includes("import")) return null;

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
  const rootScope: Scope = { parent: null, bindings: new Set(), constants: new Map() };
  collectDirectBindings(root, rootScope);
  collectVarScopeBindings(root, rootScope);

  function visit(node: AstRecord, parentScope: Scope): void {
    let scope = parentScope;
    if (isFunctionNode(node)) {
      const parameterScope: Scope = {
        parent: parentScope,
        bindings: new Set(),
        constants: new Map(),
      };
      collectBindingNames(node.id, parameterScope.bindings);
      for (const parameter of nodeArray(node.params))
        collectBindingNames(parameter, parameterScope.bindings);

      for (const parameter of nodeArray(node.params)) {
        const parameterNode = astNode(parameter);
        if (parameterNode) visit(parameterNode, parameterScope);
      }

      const body = astNode(node.body);
      if (body) {
        const bodyScope: Scope = {
          parent: parameterScope,
          bindings: new Set(),
          constants: new Map(),
        };
        collectDirectBindings(body, bodyScope);
        collectVarScopeBindings(body, bodyScope);
        if (body.type === "BlockStatement") {
          for (const statement of nodeArray(body.body)) {
            const statementNode = astNode(statement);
            if (statementNode) visit(statementNode, bodyScope);
          }
        } else {
          visit(body, bodyScope);
        }
      }
      return;
    } else if (
      (node.type === "BlockStatement" && node !== root) ||
      node.type === "StaticBlock" ||
      node.type === "TSModuleBlock"
    ) {
      scope = { parent: parentScope, bindings: new Set(), constants: new Map() };
      collectDirectBindings(node, scope);
      if (node.type === "StaticBlock" || node.type === "TSModuleBlock") {
        collectVarScopeBindings(node, scope);
      }
    } else if (node.type === "CatchClause") {
      scope = { parent: parentScope, bindings: new Set(), constants: new Map() };
      collectBindingNames(node.param, scope.bindings);
    } else if (node.type === "SwitchStatement") {
      scope = { parent: parentScope, bindings: new Set(), constants: new Map() };
      collectDirectBindings(node, scope);
    } else if (
      node.type === "ForStatement" ||
      node.type === "ForInStatement" ||
      node.type === "ForOfStatement"
    ) {
      scope = { parent: parentScope, bindings: new Set(), constants: new Map() };
      collectLoopScopeBindings(node, scope, (declaration, declarator) =>
        collectConstantBinding(declaration, declarator, scope),
      );
    } else if (node.type === "ClassExpression" && node.id) {
      scope = { parent: parentScope, bindings: new Set(), constants: new Map() };
      collectBindingNames(node.id, scope.bindings);
    }

    if (node.type === "CallExpression" && hasRange(node)) {
      const callee = unwrapExpression(node.callee);
      const argumentsList = nodeArray(node.arguments);
      if (
        isIdentifierNamed(callee, "require") &&
        !hasAstBinding(scope, "require") &&
        argumentsList.length === 1 &&
        astNode(argumentsList[0])?.type !== "SpreadElement" &&
        !hasDynamicRequestIgnoreDirective(code, node, argumentsList[0] as AstRecord) &&
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
      !hasDynamicRequestIgnoreDirective(code, node, node.source as AstRecord) &&
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
          include: /\.(?:[cm]?[jt]s|[jt]sx)(?:\?.*)?$/,
        },
      },
      handler(code, id) {
        const cleanId = id.split("?", 1)[0];
        if (!TRANSFORMABLE_EXTENSIONS.has(path.extname(cleanId))) return null;
        if (!shouldTransformVeryDynamicRequests(this.environment as EnvironmentLike, cleanId)) {
          return null;
        }
        const absoluteId = path.resolve(cleanId);
        if (
          absoluteId === VINEXT_SOURCE_ROOT ||
          absoluteId.startsWith(`${VINEXT_SOURCE_ROOT}${path.sep}`) ||
          PLUGIN_RSC_PATH.test(absoluteId)
        ) {
          return null;
        }
        return transformVeryDynamicRequests(code, id);
      },
    },
  };
}

function shouldTransformVeryDynamicRequests(environment: EnvironmentLike, id: string): boolean {
  return environment.config.consumer === "server" || /[\\/]node_modules[\\/]/.test(id);
}

export const _transformVeryDynamicRequests = transformVeryDynamicRequests;
