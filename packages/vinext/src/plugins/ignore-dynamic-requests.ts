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

function staticStringValue(
  value: unknown,
  scope: Scope,
  resolvingBindings: Set<string>,
): string | null {
  const node = unwrapExpression(value);
  if (!node) return null;
  const valueString = stringValue(node);
  if (valueString !== null) return valueString;
  if (node.type === "TemplateLiteral" && nodeArray(node.expressions).length === 0) {
    const quasi = astNode(nodeArray(node.quasis)[0]);
    const quasiValue = quasi?.value;
    const cooked =
      typeof quasiValue === "object" && quasiValue !== null
        ? Reflect.get(quasiValue, "cooked")
        : null;
    const raw =
      typeof quasiValue === "object" && quasiValue !== null ? Reflect.get(quasiValue, "raw") : null;
    return typeof cooked === "string" ? cooked : typeof raw === "string" ? raw : null;
  }
  if (node.type === "BinaryExpression" && node.operator === "+") {
    const left = staticStringValue(node.left, scope, resolvingBindings);
    const right = staticStringValue(node.right, scope, resolvingBindings);
    return left === null || right === null ? null : left + right;
  }
  if (node.type === "ConditionalExpression") {
    const truthiness = staticTruthiness(node.test, scope, resolvingBindings);
    if (truthiness !== null) {
      return staticStringValue(
        truthiness ? node.consequent : node.alternate,
        scope,
        resolvingBindings,
      );
    }
    const consequent = staticStringValue(node.consequent, scope, resolvingBindings);
    const alternate = staticStringValue(node.alternate, scope, resolvingBindings);
    return consequent !== null && consequent === alternate ? consequent : null;
  }
  if (node.type === "SequenceExpression") {
    return staticStringValue(nodeArray(node.expressions).at(-1), scope, resolvingBindings);
  }
  if (node.type === "Identifier" && typeof node.name === "string") {
    if (resolvingBindings.has(node.name)) return null;
    const binding = findConstantBinding(scope, node.name);
    if (!binding) return null;
    const nextResolvingBindings = new Set(resolvingBindings);
    nextResolvingBindings.add(node.name);
    return staticStringValue(binding, scope, nextResolvingBindings);
  }
  return null;
}

function hasSignificantPathPart(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  return normalized !== "" && normalized !== "/";
}

function templateElementValue(quasi: AstRecord | undefined, raw: boolean): string {
  const value = quasi?.value;
  if (typeof value !== "object" || value === null) return "";
  const elementValue = Reflect.get(value, raw ? "raw" : "cooked");
  return typeof elementValue === "string" ? elementValue : "";
}

function isUnboundStringRawTag(value: unknown, scope: Scope): boolean {
  const tag = unwrapExpression(value);
  const object = tag?.type === "MemberExpression" ? unwrapExpression(tag.object) : null;
  const property = tag?.type === "MemberExpression" ? unwrapExpression(tag.property) : null;
  return (
    tag?.type === "MemberExpression" &&
    tag.computed !== true &&
    isIdentifierNamed(object, "String") &&
    !hasAstBinding(scope, "String") &&
    isIdentifierNamed(property, "raw")
  );
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
  useRaw = false,
): boolean {
  const quasis = nodeArray(node.quasis).filter(isAstRecord);
  if (nodeArray(node.expressions).length === 0) {
    return templateElementValue(quasis[0], useRaw).replaceAll("\\", "/") !== "/";
  }
  if (quasis.some((quasi) => hasSignificantPathPart(templateElementValue(quasi, useRaw)))) {
    return true;
  }

  return nodeArray(node.expressions).some((expression) => {
    const expressionNode = unwrapExpression(expression);
    if (!expressionNode) return false;
    return requestHasStaticPart(expressionNode, scope, resolvingBindings);
  });
}

function stringRawTemplateHasStaticPart(
  node: AstRecord,
  scope: Scope,
  resolvingBindings: Set<string>,
): boolean | null {
  if (node.type !== "TaggedTemplateExpression") return null;
  if (!isUnboundStringRawTag(node.tag, scope)) return null;
  const quasi = astNode(node.quasi);
  return quasi?.type === "TemplateLiteral"
    ? templateHasStaticPart(quasi, scope, resolvingBindings, true)
    : null;
}

function isLiteralExpression(value: unknown): boolean {
  const node = unwrapExpression(value);
  return node?.type === "Literal" || node?.type === "StringLiteral";
}

function isNegativeNumericLiteral(value: unknown): boolean {
  const node = unwrapExpression(value);
  if (node?.type !== "UnaryExpression" || node.operator !== "-") return false;
  const argument = unwrapExpression(node.argument);
  return argument?.type === "Literal" && typeof argument.value === "number";
}

function templateTruthiness(
  node: AstRecord,
  scope: Scope,
  resolvingBindings: Set<string>,
  useRaw = false,
): boolean | null {
  const quasis = nodeArray(node.quasis).filter(isAstRecord);
  if (quasis.some((quasi) => templateElementValue(quasi, useRaw) !== "")) return true;

  let hasUnknownExpression = false;
  for (const expression of nodeArray(node.expressions)) {
    const string = staticStringValue(expression, scope, resolvingBindings);
    if (string !== null) {
      if (string !== "") return true;
      continue;
    }
    const expressionNode = unwrapExpression(expression);
    if (
      isNegativeNumericLiteral(expressionNode) ||
      staticTruthiness(expressionNode, scope, resolvingBindings) !== null
    ) {
      return true;
    }
    hasUnknownExpression = true;
  }
  return hasUnknownExpression ? null : false;
}

function staticTruthiness(
  value: unknown,
  scope: Scope,
  resolvingBindings = new Set<string>(),
): boolean | null {
  const node = unwrapExpression(value);
  if (!node) return null;
  if (node.type === "Literal" || node.type === "StringLiteral") return Boolean(node.value);
  if (node.type === "TemplateLiteral") {
    return templateTruthiness(node, scope, resolvingBindings);
  }
  if (node.type === "TaggedTemplateExpression" && isUnboundStringRawTag(node.tag, scope)) {
    const quasi = astNode(node.quasi);
    return quasi?.type === "TemplateLiteral"
      ? templateTruthiness(quasi, scope, resolvingBindings, true)
      : null;
  }
  if (node.type === "BinaryExpression" && node.operator === "+") {
    const string = staticStringValue(node, scope, resolvingBindings);
    return string === null ? null : Boolean(string);
  }
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
      return isLiteralExpression(node.argument) ? false : null;
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
    return node.operator === "void" && isLiteralExpression(node.argument) ? true : null;
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
      ? property === null || staticStringValue(property, scope, resolvingBindings) !== "concat"
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
  if (node.type === "BinaryExpression" && node.operator === "+") {
    return additionContainsString(node, scope, resolvingBindings);
  }
  if (node.type === "ConditionalExpression") {
    return (
      isStaticStringExpression(node.consequent, scope, resolvingBindings) &&
      isStaticStringExpression(node.alternate, scope, resolvingBindings)
    );
  }
  if (node.type === "SequenceExpression") {
    return isStaticStringExpression(nodeArray(node.expressions).at(-1), scope, resolvingBindings);
  }
  if (node.type === "CallExpression") {
    return stringConcatHasStaticPart(node, scope, resolvingBindings) !== null;
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
  const stringRawHasStaticPart = stringRawTemplateHasStaticPart(node, scope, resolvingBindings);
  if (stringRawHasStaticPart !== null) return stringRawHasStaticPart;
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
      return isLiteralExpression(node.argument);
    }
    if (isNegativeNumericLiteral(node)) return true;
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
    if (expressions.length === 0) return false;
    return (
      expressions
        .slice(0, -1)
        .every((expression) => !expressionMayHaveSideEffects(expression, scope)) &&
      requestHasStaticPart(expressions.at(-1), scope, resolvingBindings)
    );
  }

  return false;
}

function expressionMayHaveSideEffects(value: unknown, scope: Scope): boolean {
  const node = unwrapExpression(value);
  if (!node) return false;
  if (
    node.type === "Literal" ||
    node.type === "StringLiteral" ||
    node.type === "Identifier" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  ) {
    return false;
  }
  if (node.type === "TemplateLiteral") {
    return nodeArray(node.expressions).some((expression) =>
      expressionMayHaveSideEffects(expression, scope),
    );
  }
  if (node.type === "UnaryExpression") {
    return node.operator === "delete" || expressionMayHaveSideEffects(node.argument, scope);
  }
  if (node.type === "AwaitExpression") {
    return expressionMayHaveSideEffects(node.argument, scope);
  }
  if (node.type === "BinaryExpression" || node.type === "LogicalExpression") {
    return (
      expressionMayHaveSideEffects(node.left, scope) ||
      expressionMayHaveSideEffects(node.right, scope)
    );
  }
  if (node.type === "ConditionalExpression") {
    return (
      expressionMayHaveSideEffects(node.test, scope) ||
      expressionMayHaveSideEffects(node.consequent, scope) ||
      expressionMayHaveSideEffects(node.alternate, scope)
    );
  }
  if (node.type === "SequenceExpression") {
    return nodeArray(node.expressions).some((expression) =>
      expressionMayHaveSideEffects(expression, scope),
    );
  }
  if (node.type === "ArrayExpression") {
    return nodeArray(node.elements).some((element) => {
      const elementNode = astNode(element);
      return (
        elementNode?.type === "SpreadElement" || expressionMayHaveSideEffects(elementNode, scope)
      );
    });
  }
  if (node.type === "ObjectExpression") {
    return nodeArray(node.properties).some((property) => {
      const propertyNode = astNode(property);
      if (propertyNode?.type === "SpreadElement") {
        return expressionMayHaveSideEffects(propertyNode.argument, scope);
      }
      if (
        propertyNode?.type !== "Property" ||
        propertyNode.kind !== "init" ||
        propertyNode.method === true
      ) {
        return true;
      }
      return (
        expressionMayHaveSideEffects(propertyNode.computed ? propertyNode.key : null, scope) ||
        expressionMayHaveSideEffects(propertyNode.value, scope)
      );
    });
  }
  if (node.type === "MemberExpression") {
    return (
      expressionMayHaveSideEffects(node.object, scope) ||
      expressionMayHaveSideEffects(node.computed ? node.property : null, scope)
    );
  }
  if (node.type === "TaggedTemplateExpression") {
    if (isUnboundStringRawTag(node.tag, scope)) {
      const quasi = astNode(node.quasi);
      return (
        quasi?.type !== "TemplateLiteral" ||
        nodeArray(quasi.expressions).some((expression) =>
          expressionMayHaveSideEffects(expression, scope),
        )
      );
    }
    return true;
  }
  if (node.type === "MetaProperty") return false;
  return true;
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
    } else if (node.type === "SwitchStatement") {
      const discriminant = astNode(node.discriminant);
      if (discriminant) visit(discriminant, parentScope);
      const switchScope: Scope = {
        parent: parentScope,
        bindings: new Set(),
        constants: new Map(),
      };
      collectDirectBindings(node, switchScope);
      for (const switchCase of nodeArray(node.cases)) {
        const switchCaseNode = astNode(switchCase);
        if (switchCaseNode) visit(switchCaseNode, switchScope);
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
