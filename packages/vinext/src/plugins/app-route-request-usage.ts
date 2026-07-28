import MagicString from "magic-string";
import { parseAst, type Plugin } from "vite";
import { APP_ROUTE_REQUEST_USAGE_EXPORT } from "../server/app-route-handler-request-usage.js";

const ROUTE_HANDLER_METHODS = ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"] as const;
const ROUTE_HANDLER_METHOD_SET = new Set<string>(ROUTE_HANDLER_METHODS);
// Standard Request/NextRequest fields whose direct read either triggers one of
// createTrackedAppRouteRequest's accessors or returns a primitive/known platform
// object. Unknown and inherited members fail closed because Request is
// extensible and can otherwise be taught a getter that returns its raw self.
const SAFE_REQUEST_PROPERTIES = new Set([
  "arrayBuffer",
  "blob",
  "body",
  "bodyUsed",
  "bytes",
  "cache",
  "cookies",
  "credentials",
  "destination",
  "duplex",
  "formData",
  "geo",
  "headers",
  "integrity",
  "ip",
  "isHistoryNavigation",
  "isReloadNavigation",
  "json",
  "keepalive",
  "method",
  "mode",
  "redirect",
  "referrer",
  "referrerPolicy",
  "signal",
  "text",
  "url",
]);
// Mirrors the NextURL surface whose direct access is either tracked by
// wrapNextUrl() or deliberately static in Next.js. Unknown/inherited methods
// fail closed because binding them to the raw target can bypass the proxy (for
// example Object.prototype.valueOf/toLocaleString).
const SAFE_NEXT_URL_PROPERTIES = new Set([
  "basePath",
  "buildId",
  "defaultLocale",
  "domainLocale",
  "hash",
  "host",
  "hostname",
  "href",
  "locale",
  "locales",
  "origin",
  "password",
  "pathname",
  "port",
  "protocol",
  "search",
  "searchParams",
  "toJSON",
  "toString",
  "url",
  "username",
]);

type AstNode = {
  type: string;
  [key: string]: unknown;
};

type FunctionNode = AstNode & {
  body?: AstNode;
  params?: AstNode[];
};

function isAstNode(value: unknown): value is AstNode {
  return !!value && typeof value === "object" && typeof (value as AstNode).type === "string";
}

function isFunctionNode(value: unknown): value is FunctionNode {
  return (
    isAstNode(value) &&
    (value.type === "FunctionDeclaration" ||
      value.type === "FunctionExpression" ||
      value.type === "ArrowFunctionExpression")
  );
}

function walkAst(node: unknown, visit: (node: AstNode) => boolean | void): boolean {
  if (!isAstNode(node)) return false;
  if (visit(node)) return true;

  for (const [key, value] of Object.entries(node)) {
    if (key === "parent" || key === "loc" || key === "start" || key === "end") continue;
    if (Array.isArray(value)) {
      for (const child of value) {
        if (walkAst(child, visit)) return true;
      }
    } else if (walkAst(value, visit)) {
      return true;
    }
  }
  return false;
}

function containsIdentifier(node: unknown, name: string): boolean {
  return walkAst(node, (candidate) => candidate.type === "Identifier" && candidate.name === name);
}

function containsDirectEval(node: unknown): boolean {
  return walkAst(
    node,
    (candidate) =>
      candidate.type === "CallExpression" &&
      isAstNode(candidate.callee) &&
      candidate.callee.type === "Identifier" &&
      candidate.callee.name === "eval" &&
      candidate.optional !== true,
  );
}

function memberPropertyName(member: AstNode): string | null {
  const property = member.property;
  if (!isAstNode(property)) return null;
  if (!member.computed && property.type === "Identifier" && typeof property.name === "string") {
    return property.name;
  }
  if (member.computed && property.type === "Literal" && typeof property.value === "string") {
    return property.value;
  }
  return null;
}

function isMutatedMember(member: AstNode, parent: AstNode | null): boolean {
  if (!parent) return false;
  return (
    ((parent.type === "AssignmentExpression" || parent.type === "UpdateExpression") &&
      (parent.left === member || parent.argument === member)) ||
    (parent.type === "UnaryExpression" &&
      parent.operator === "delete" &&
      parent.argument === member)
  );
}

function safelyDestructuresRequest(pattern: unknown, fromNextUrl = false): boolean {
  if (
    !isAstNode(pattern) ||
    pattern.type !== "ObjectPattern" ||
    !Array.isArray(pattern.properties)
  ) {
    return false;
  }
  for (const rawProperty of pattern.properties) {
    if (!isAstNode(rawProperty) || rawProperty.type !== "Property" || rawProperty.computed) {
      return false;
    }
    const key = isAstNode(rawProperty.key) ? rawProperty.key : null;
    const name =
      key?.type === "Identifier" && typeof key.name === "string"
        ? key.name
        : key?.type === "Literal" && typeof key.value === "string"
          ? key.value
          : null;
    if (
      !name ||
      name === "clone" ||
      name === "valueOf" ||
      (fromNextUrl
        ? !SAFE_NEXT_URL_PROPERTIES.has(name)
        : name !== "nextUrl" && !SAFE_REQUEST_PROPERTIES.has(name))
    ) {
      return false;
    }

    const value = rawProperty.value;
    if (name === "nextUrl") {
      // Reading nextUrl alone is deliberately untracked. Only a nested
      // destructure proves that a concrete NextURL field is read immediately.
      if (!safelyDestructuresRequest(value, true)) return false;
    } else if (isAstNode(value) && value.type === "AssignmentPattern") {
      return false;
    }
  }
  return true;
}

function requestBindingEscapes(node: unknown, bindingName: string): boolean {
  function visit(
    value: unknown,
    parent: AstNode | null,
    grandparent: AstNode | null,
    greatGrandparent: AstNode | null,
  ): boolean {
    if (!isAstNode(value)) return false;
    if (value.type === "Identifier" && value.name === bindingName) {
      if (parent?.type === "MemberExpression" && parent.object === value) {
        const property = memberPropertyName(parent);
        if (
          !property ||
          property === "clone" ||
          property === "valueOf" ||
          isMutatedMember(parent, grandparent)
        ) {
          return true;
        }
        if (property === "nextUrl") {
          if (grandparent?.type !== "MemberExpression" || grandparent.object !== parent)
            return true;
          const nextUrlProperty = memberPropertyName(grandparent);
          return (
            !nextUrlProperty ||
            !SAFE_NEXT_URL_PROPERTIES.has(nextUrlProperty) ||
            isMutatedMember(grandparent, greatGrandparent)
          );
        }
        if (!SAFE_REQUEST_PROPERTIES.has(property)) return true;
        // Direct property/method reads retain the existing precise runtime
        // tracking. This includes static fields such as method and tracked
        // getters such as url/headers/json.
        return false;
      }
      if (
        parent?.type === "VariableDeclarator" &&
        parent.init === value &&
        safelyDestructuresRequest(parent.id)
      ) {
        return false;
      }
      if (
        parent?.type === "AssignmentExpression" &&
        parent.right === value &&
        safelyDestructuresRequest(parent.left)
      ) {
        return false;
      }
      return true;
    }

    for (const [key, child] of Object.entries(value)) {
      if (key === "parent" || key === "loc" || key === "start" || key === "end") continue;
      if (Array.isArray(child)) {
        for (const item of child) {
          if (visit(item, value, parent, grandparent)) return true;
        }
      } else if (visit(child, value, parent, grandparent)) {
        return true;
      }
    }
    return false;
  }

  return visit(node, null, null, null);
}

/**
 * Returns false only when the handler's request argument is statically proven
 * unused. Any unresolved syntax fails closed to true.
 */
function functionMayUseRequest(fn: FunctionNode): boolean {
  const params = fn.params;
  if (!Array.isArray(params)) return true;

  // `arguments[0]` can consume the request even when the declaration has no
  // formal parameters. Nested/shadowed occurrences are intentionally treated
  // as usage: false positives only disable caching, while false negatives can
  // cross-cache request-specific data.
  const laterParams = params.slice(1);
  if (
    containsDirectEval(fn.body) ||
    containsDirectEval({ type: "ArrayExpression", elements: laterParams }) ||
    containsIdentifier(fn.body, "arguments") ||
    containsIdentifier({ type: "ArrayExpression", elements: laterParams }, "arguments")
  ) {
    return true;
  }
  if (params.length === 0) return false;

  const first = params[0];
  if (first.type === "ObjectPattern") return !safelyDestructuresRequest(first);
  // Defaults and rest parameters fail closed. This also avoids Function.length's
  // default/rest blind spot.
  if (first.type !== "Identifier" || typeof first.name !== "string") return true;
  return (
    requestBindingEscapes(fn.body, first.name) ||
    requestBindingEscapes({ type: "ArrayExpression", elements: laterParams }, first.name)
  );
}

function declaredIdentifierName(node: unknown): string | null {
  return isAstNode(node) && node.type === "Identifier" && typeof node.name === "string"
    ? node.name
    : null;
}

type TopLevelBinding = {
  immutable: boolean;
  value: unknown;
};

function collectTopLevelBindings(body: AstNode[]): Map<string, TopLevelBinding> {
  const bindings = new Map<string, TopLevelBinding>();

  const collectDeclaration = (declaration: unknown): void => {
    if (!isAstNode(declaration)) return;
    if (declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration") {
      const name = declaredIdentifierName(declaration.id);
      if (name) bindings.set(name, { immutable: false, value: declaration });
      return;
    }
    if (declaration.type !== "VariableDeclaration" || !Array.isArray(declaration.declarations)) {
      return;
    }
    for (const item of declaration.declarations) {
      if (!isAstNode(item) || item.type !== "VariableDeclarator") continue;
      const name = declaredIdentifierName(item.id);
      if (name) {
        bindings.set(name, {
          immutable: declaration.kind === "const",
          value: item.init,
        });
      }
    }
  };

  for (const statement of body) {
    if (statement.type === "ImportDeclaration" && Array.isArray(statement.specifiers)) {
      for (const specifier of statement.specifiers) {
        if (!isAstNode(specifier)) continue;
        const name = declaredIdentifierName(specifier.local);
        if (name) bindings.set(name, { immutable: true, value: null });
      }
      continue;
    }
    collectDeclaration(
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement,
    );
  }
  return bindings;
}

function collectWrittenBindings(body: AstNode[]): Set<string> {
  const written = new Set<string>();
  const collectNames = (value: unknown): void => {
    if (!isAstNode(value)) return;
    if (value.type === "Identifier" && typeof value.name === "string") {
      written.add(value.name);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === "parent" || key === "loc" || key === "start" || key === "end") continue;
      if (Array.isArray(child)) child.forEach(collectNames);
      else collectNames(child);
    }
  };

  walkAst({ type: "Program", body }, (node) => {
    if (node.type === "AssignmentExpression") collectNames(node.left);
    else if (node.type === "UpdateExpression") collectNames(node.argument);
    else if (node.type === "ForInStatement" || node.type === "ForOfStatement") {
      collectNames(node.left);
    }
    return false;
  });
  return written;
}

function exportedName(specifier: AstNode): string | null {
  const exported = specifier.exported;
  if (!isAstNode(exported)) return null;
  if (exported.type === "Identifier" && typeof exported.name === "string") return exported.name;
  if (exported.type === "Literal" && typeof exported.value === "string") return exported.value;
  return null;
}

function localName(specifier: AstNode): string | null {
  return declaredIdentifierName(specifier.local);
}

function resolveBindingUsage(
  binding: TopLevelBinding | undefined,
  written: Set<string>,
  bindingName: string,
  moduleHasDirectEval: boolean,
): boolean {
  if (
    !binding ||
    !isFunctionNode(binding.value) ||
    (!binding.immutable && (moduleHasDirectEval || written.has(bindingName)))
  ) {
    return true;
  }
  return functionMayUseRequest(binding.value);
}

export type AppRouteRequestUsageAnalysis = {
  collision: boolean;
  hasRouteMethodCandidate: boolean;
  metadata: Partial<Record<(typeof ROUTE_HANDLER_METHODS)[number], boolean>>;
};

export function analyzeAppRouteRequestUsage(code: string): AppRouteRequestUsageAnalysis {
  const ast = parseAst(code);
  const body = ast.body as unknown as AstNode[];
  const bindings = collectTopLevelBindings(body);
  const written = collectWrittenBindings(body);
  const moduleHasDirectEval = containsDirectEval({ type: "Program", body });
  const metadata: AppRouteRequestUsageAnalysis["metadata"] = {};
  let collision = bindings.has(APP_ROUTE_REQUEST_USAGE_EXPORT);
  let hasRouteMethodCandidate = false;

  for (const statement of body) {
    if (statement.type === "ExportAllDeclaration") {
      hasRouteMethodCandidate = true;
      continue;
    }
    if (statement.type !== "ExportNamedDeclaration") continue;

    const declaration = isAstNode(statement.declaration) ? statement.declaration : null;
    if (declaration?.type === "FunctionDeclaration") {
      const name = declaredIdentifierName(declaration.id);
      if (name === APP_ROUTE_REQUEST_USAGE_EXPORT) collision = true;
      if (name && ROUTE_HANDLER_METHOD_SET.has(name)) {
        hasRouteMethodCandidate = true;
        metadata[name as keyof typeof metadata] = resolveBindingUsage(
          bindings.get(name),
          written,
          name,
          moduleHasDirectEval,
        );
      }
    } else if (declaration?.type === "VariableDeclaration") {
      for (const item of Array.isArray(declaration.declarations) ? declaration.declarations : []) {
        if (!isAstNode(item) || item.type !== "VariableDeclarator") continue;
        const name = declaredIdentifierName(item.id);
        if (name === APP_ROUTE_REQUEST_USAGE_EXPORT) collision = true;
        if (name && ROUTE_HANDLER_METHOD_SET.has(name)) {
          hasRouteMethodCandidate = true;
          metadata[name as keyof typeof metadata] = resolveBindingUsage(
            bindings.get(name),
            written,
            name,
            moduleHasDirectEval,
          );
        }
      }
    }

    if (!Array.isArray(statement.specifiers)) continue;
    for (const rawSpecifier of statement.specifiers) {
      if (!isAstNode(rawSpecifier) || rawSpecifier.type !== "ExportSpecifier") continue;
      const exported = exportedName(rawSpecifier);
      if (exported === APP_ROUTE_REQUEST_USAGE_EXPORT) collision = true;
      if (!exported || !ROUTE_HANDLER_METHOD_SET.has(exported)) continue;
      hasRouteMethodCandidate = true;
      const local = localName(rawSpecifier);
      metadata[exported as keyof typeof metadata] =
        statement.source != null || !local
          ? true
          : resolveBindingUsage(bindings.get(local), written, local, moduleHasDirectEval);
    }
  }

  // `export *` can supply any HTTP method from an unresolved module. Missing
  // metadata already fails closed at runtime, so no explicit entries are needed.
  return { collision, hasRouteMethodCandidate, metadata };
}

export function transformAppRouteRequestUsage(code: string, id: string) {
  const analysis = analyzeAppRouteRequestUsage(code);
  if (!analysis.hasRouteMethodCandidate) return null;
  if (analysis.collision) {
    throw new Error(
      `Route handler ${id} exports vinext's reserved internal name ${APP_ROUTE_REQUEST_USAGE_EXPORT}. Rename that export.`,
    );
  }

  const output = new MagicString(code);
  output.append(
    `\nexport const ${APP_ROUTE_REQUEST_USAGE_EXPORT} = Object.freeze(${JSON.stringify(analysis.metadata)});\n`,
  );
  return {
    code: output.toString(),
    map: output.generateMap({ hires: "boundary" }),
  };
}

export function createAppRouteRequestUsagePlugin(): Plugin {
  return {
    name: "vinext:app-route-request-usage",
    transform: {
      filter: {
        id: {
          include: /(?:^|[/\\])route\.[cm]?[jt]sx?(?:\?.*)?$/,
          exclude: /node_modules/,
        },
      },
      handler(code, id) {
        return transformAppRouteRequestUsage(code, id);
      },
    },
  };
}
