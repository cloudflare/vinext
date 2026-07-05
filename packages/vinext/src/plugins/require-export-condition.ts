import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire, isBuiltin } from "node:module";
import MagicString from "magic-string";
import { parseAst, type Plugin } from "vite";
import {
  collectBindingNames,
  forEachAstChild,
  hasRange,
  isAstRecord,
  nodeArray,
  type AstRange,
  type AstRecord,
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

const REQUIRE_PROXY_PREFIX = "virtual:vinext-require-condition:";
const REQUIRE_MODULE_SUFFIX = ".vinext-require.js";
const NODE_MODULES_RE = /[\\/]node_modules[\\/]/;

type StaticRequire = {
  argument: AstRange;
  call: AstRange;
  specifier: string;
};

type RequireExportConditionPluginOptions = {
  externalRequireSpecifiers?: Set<string>;
};

export function createRequireExportConditionPlugin(
  options: RequireExportConditionPluginOptions = {},
): Plugin {
  const clientRequireModules = new Map<string, string>();
  const serverRequireModules = new Map<string, string>();
  const externalRequireModules = new Map<string, string>();

  return {
    name: "vinext:require-export-condition",
    enforce: "pre",
    sharedDuringBuild: true,
    transform: {
      filter: {
        id: {
          include: /\.(?:[cm]?[jt]s|[jt]sx)(?:\?.*)?$/i,
          exclude: NODE_MODULES_RE,
        },
        code: /\brequire\s*\(/,
      },
      async handler(code, id) {
        if (this.environment && this.environment.name !== "rsc") return null;
        if (isNodeModulesId(id)) return null;

        let ast: unknown;
        try {
          ast = parseAst(code, { lang: langForId(id) });
        } catch {
          return null;
        }
        const requires = collectStaticPackageRequires(ast);
        if (requires.length === 0) return null;

        let output: MagicString | undefined;
        for (const requireCall of requires) {
          const resolved = await this.resolve(requireCall.specifier, id, {
            skipSelf: true,
            kind: "require-call",
          });
          if (!resolved || isVirtualId(resolved.id)) continue;

          output ??= new MagicString(code);
          const proxyId = createRequireProxyId(requireCall.specifier, id);
          output.overwrite(
            requireCall.argument.start,
            requireCall.argument.end,
            JSON.stringify(proxyId),
          );
          output.appendRight(requireCall.call.end, ".__vinextRequireValue");
        }

        if (!output) return null;

        return {
          code: output.toString(),
          map: output.generateMap({ hires: "boundary" }),
        };
      },
    },
    async resolveId(id, importer) {
      const cleanId = id.startsWith("\0") ? id.slice(1) : id;
      const specifier = parseRequireProxySpecifier(cleanId);
      if (!specifier || !importer) return null;

      const resolved = await this.resolve(specifier, importer, {
        skipSelf: true,
        kind: "require-call",
      });
      if (!resolved || isVirtualId(resolved.id)) return resolved;
      if (resolved.external) {
        const requireModuleId = `\0${cleanId}${REQUIRE_MODULE_SUFFIX}`;
        externalRequireModules.set(requireModuleId, specifier);
        options.externalRequireSpecifiers?.add(specifier);
        return requireModuleId;
      }

      let requireResolvedId = resolved.id;
      if (isNodeModulesId(resolved.id)) {
        try {
          requireResolvedId = createRequire(cleanModuleId(importer)).resolve(specifier);
        } catch {}
      }
      if (!(await hasLeadingUseClientDirective(requireResolvedId))) {
        const requireModuleId = `\0${cleanId}${REQUIRE_MODULE_SUFFIX}`;
        serverRequireModules.set(requireModuleId, requireResolvedId);
        return requireModuleId;
      }

      const requireModuleId = `\0${cleanId}${REQUIRE_MODULE_SUFFIX}`;
      clientRequireModules.set(requireModuleId, requireResolvedId);
      return requireModuleId;
    },
    load(id) {
      const realId = clientRequireModules.get(id);
      if (realId) {
        return `'use client';
import * as namespace from ${JSON.stringify(realId)};
const value = "default" in namespace ? namespace.default : namespace;
export { value as __vinextRequireValue };
`;
      }

      const serverId = serverRequireModules.get(id);
      if (serverId) {
        return `import * as namespace from ${JSON.stringify(serverId)};
const value = "default" in namespace ? namespace.default : namespace;
export { value as __vinextRequireValue };
`;
      }

      const specifier = externalRequireModules.get(id);
      if (!specifier) return null;
      return `import { createRequire } from "node:module";
const value = createRequire(import.meta.url)(${JSON.stringify(specifier)});
export { value as __vinextRequireValue };
`;
    },
  };
}

function createRequireProxyId(specifier: string, importer: string): string {
  const importerHash = createHash("sha256").update(importer).digest("hex").slice(0, 16);
  return `${REQUIRE_PROXY_PREFIX}${importerHash}:${encodeURIComponent(specifier)}`;
}

function parseRequireProxySpecifier(id: string): string | null {
  if (!id.startsWith(REQUIRE_PROXY_PREFIX)) return null;
  const separator = id.indexOf(":", REQUIRE_PROXY_PREFIX.length);
  if (separator === -1) return null;
  try {
    return decodeURIComponent(id.slice(separator + 1));
  } catch {
    return null;
  }
}

function cleanModuleId(id: string): string {
  return id.split("?", 1)[0] ?? id;
}

function isVirtualId(id: string): boolean {
  return id.startsWith("\0") || id.startsWith("virtual:");
}

function isNodeModulesId(id: string): boolean {
  return id.replaceAll("\\", "/").includes("/node_modules/");
}

async function hasLeadingUseClientDirective(id: string): Promise<boolean> {
  const filePath = id.split("?", 1)[0] ?? id;
  try {
    return getLeadingReactDirective(await readFile(filePath, "utf8")) === "use client";
  } catch {
    return false;
  }
}

function getLeadingReactDirective(code: string): "use client" | "use server" | null {
  let index = code.charCodeAt(0) === 0xfeff ? 1 : 0;
  if (code[index] === "#" && code[index + 1] === "!") {
    const newline = code.indexOf("\n", index);
    if (newline === -1) return null;
    index = newline + 1;
  }

  while (index < code.length) {
    while (index < code.length && /\s/.test(code[index] ?? "")) index++;
    if (code[index] === "/" && code[index + 1] === "/") {
      const newline = code.indexOf("\n", index + 2);
      if (newline === -1) return null;
      index = newline + 1;
      continue;
    }
    if (code[index] === "/" && code[index + 1] === "*") {
      const end = code.indexOf("*/", index + 2);
      if (end === -1) return null;
      index = end + 2;
      continue;
    }

    const quote = code[index];
    if (quote !== '"' && quote !== "'") return null;
    const closing = code.indexOf(quote, index + 1);
    if (closing === -1) return null;
    const directive = code.slice(index + 1, closing);
    if (directive === "use client" || directive === "use server") return directive;
    index = closing + 1;
    while (
      index < code.length &&
      (code[index] === ";" || code[index] === " " || code[index] === "\t")
    ) {
      index++;
    }
    if (code[index] === "\n") index++;
  }
  return null;
}

function langForId(id: string): "jsx" | "ts" | "tsx" {
  const cleanId = id.split("?", 1)[0]?.toLowerCase() ?? id.toLowerCase();
  if (cleanId.endsWith(".tsx")) return "tsx";
  if (cleanId.endsWith(".ts") || cleanId.endsWith(".mts") || cleanId.endsWith(".cts")) {
    return "ts";
  }
  return "jsx";
}

function collectStaticPackageRequires(ast: unknown): StaticRequire[] {
  const requires: StaticRequire[] = [];
  if (!isAstRecord(ast)) return requires;

  const rootScope = createAstScope(null);
  collectDirectScopeBindings(ast, rootScope);
  collectVarScopeBindings(ast, rootScope);

  function visit(node: AstRecord, parentScope: AstScope): void {
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
          for (const statement of nodeArray(node.body.body)) {
            if (isAstRecord(statement)) visit(statement, bodyScope);
          }
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

    const scope = createChildRequireScope(node, parentScope) ?? parentScope;
    const requireCall = parseStaticPackageRequire(node, scope);
    if (requireCall) {
      requires.push(requireCall);
      return;
    }
    forEachAstChild(node, (child) => {
      if (isAstRecord(child)) visit(child, scope);
    });
  }

  for (const statement of nodeArray(ast.body)) {
    if (isAstRecord(statement)) visit(statement, rootScope);
  }
  return requires;
}

function createChildRequireScope(node: AstRecord, parentScope: AstScope): AstScope | null {
  if (
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

  const scope = createAstScope(parentScope);
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

function parseStaticPackageRequire(node: AstRecord, scope: AstScope): StaticRequire | null {
  if (node.type !== "CallExpression" || !hasRange(node)) return null;
  const callee = node.callee;
  if (!isAstRecord(callee) || callee.type !== "Identifier" || callee.name !== "require") {
    return null;
  }
  if (hasAstBinding(scope, "require")) return null;

  const args = nodeArray(node.arguments);
  if (args.length !== 1) return null;
  const argument = args[0];
  if (!isAstRecord(argument) || !hasRange(argument)) return null;

  const specifier = stringLiteralValue(argument);
  if (!specifier || !isPackageSpecifier(specifier)) return null;
  return { argument, call: node, specifier };
}

function stringLiteralValue(node: AstRecord): string | null {
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "StringLiteral" && typeof node.value === "string") return node.value;
  return null;
}

function isPackageSpecifier(specifier: string): boolean {
  return (
    !specifier.startsWith(".") &&
    !specifier.startsWith("/") &&
    !specifier.startsWith("\\") &&
    !isBuiltin(specifier) &&
    !specifier.includes("\0")
  );
}
