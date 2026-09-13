import MagicString from "magic-string";
import { readFile } from "node:fs/promises";
import path from "pathslash";
import { createIdResolver, parseAst, type ESTree, type Plugin } from "vite";
import {
  collectBindingNames,
  forEachAstChild,
  isIdentifierNamed,
  SCRIPT_MODULE_ID_RE,
  scriptParserLanguage,
  staticStringValue,
  unwrapExpression,
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

const LITERAL_REQUIRE_RE = /\brequire\s*\(/;
const CONDITIONAL_REQUIRE_SCRIPT_ID_RE = /\.vinext-require\.(?:js|jsx|ts|tsx)$/i;
type LiteralRequire = {
  argument: ESTree.Node;
  specifier: string;
};

type SyntheticModuleType = "js" | "jsx" | "json" | "ts" | "tsx";

export function isConditionalRequireScriptModuleId(id: string): boolean {
  return CONDITIONAL_REQUIRE_SCRIPT_ID_RE.test(stripViteModuleQuery(id));
}

function syntheticModuleType(id: string): SyntheticModuleType {
  const extension = path.extname(stripViteModuleQuery(id)).toLowerCase();
  if (extension === ".json") return "json";
  if (extension === ".jsx") return "jsx";
  if (extension === ".tsx") return "tsx";
  if (extension === ".ts" || extension === ".mts" || extension === ".cts") return "ts";
  return "js";
}

function literalString(value: ESTree.Node | null | undefined): string | null {
  const node = unwrapExpression(value);
  return staticStringValue(node);
}

function isPackageSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith("#") ||
    (!specifier.startsWith(".") &&
      !specifier.startsWith("/") &&
      !specifier.startsWith("\\") &&
      !/^[a-z][a-z\d+.-]*:/i.test(specifier))
  );
}

function collectLiteralRequires(code: string, id: string): LiteralRequire[] {
  let ast: ReturnType<typeof parseAst>;
  try {
    ast = parseAst(code, { lang: scriptParserLanguage(id) ?? "jsx" });
  } catch {
    return [];
  }

  const root = ast;
  const requires: LiteralRequire[] = [];
  const rootScope = createAstScope(null);
  collectDirectScopeBindings(root, rootScope);
  collectVarScopeBindings(root, rootScope);

  function visit(node: ESTree.Node, parentScope: AstScope): void {
    let scope = parentScope;
    if (isFunctionNode(node)) {
      const parameterScope = createAstScope(parentScope);
      collectBindingNames(node.id, parameterScope.bindings);
      for (const parameter of node.params) {
        collectBindingNames(parameter, parameterScope.bindings);
        visit(parameter, parameterScope);
      }

      const body = node.body;
      if (body) {
        const bodyScope = createAstScope(parameterScope);
        collectDirectScopeBindings(body, bodyScope);
        collectVarScopeBindings(body, bodyScope);
        if (body.type === "BlockStatement") {
          for (const statement of body.body) visit(statement, bodyScope);
        } else {
          visit(body, bodyScope);
        }
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

    if (
      node.type === "BlockStatement" ||
      node.type === "StaticBlock" ||
      node.type === "TSModuleBlock"
    ) {
      scope = createAstScope(parentScope);
      collectDirectScopeBindings(node, scope);
      if (node.type === "StaticBlock" || node.type === "TSModuleBlock") {
        collectVarScopeBindings(node, scope);
      }
    } else if (node.type === "CatchClause") {
      scope = createAstScope(parentScope);
      collectBindingNames(node.param, scope.bindings);
    } else if (
      node.type === "ForStatement" ||
      node.type === "ForInStatement" ||
      node.type === "ForOfStatement"
    ) {
      scope = createAstScope(parentScope);
      collectLoopScopeBindings(node, scope);
    } else if (node.type === "ClassExpression" && node.id) {
      scope = createAstScope(parentScope);
      collectBindingNames(node.id, scope.bindings);
    }

    if (node.type === "CallExpression") {
      const callee = unwrapExpression(node.callee);
      const args = node.arguments;
      const argument = unwrapExpression(args[0]);
      const specifier = literalString(argument);
      if (
        isIdentifierNamed(callee, "require") &&
        !hasAstBinding(scope, "require") &&
        args.length === 1 &&
        argument &&
        specifier !== null &&
        isPackageSpecifier(specifier)
      ) {
        requires.push({ argument, specifier });
        return;
      }
    }

    forEachAstChild(node, (child) => visit(child, scope));
  }

  for (const statement of root.body) visit(statement, rootScope);
  return requires;
}

/**
 * Resolve literal package `require()` calls while Vite still knows they are
 * CommonJS references. `vite-plugin-commonjs` subsequently hoists each call
 * into a static import; without this pre-resolution, Vite sees an
 * `import-statement` and selects the package's `import` export condition. Use
 * Vite's explicit `isRequire` resolver because the dev plugin container does
 * not preserve a synthetic `kind: "require-call"` passed through `this.resolve`.
 */
type IdResolverFactory = typeof createIdResolver;
type CommonJsTransformFilter = (id: string) => boolean | undefined;

export function createRequireConditionResolutionPlugin(
  createResolver: IdResolverFactory = createIdResolver,
  commonjsTransformFilter?: CommonJsTransformFilter,
): Plugin {
  // Vite reuses this plugin instance across its RSC, SSR, and client
  // environments, so the synthetic identity has to resolve in each graph.
  // Entries are keyed by the query-free resolved file path and are therefore
  // bounded by the distinct conditional package targets seen by the app.
  const virtualTargets = new Map<string, { file: string; moduleType: SyntheticModuleType }>();
  let resolveImport: ReturnType<IdResolverFactory> | undefined;
  let resolveRequire: ReturnType<IdResolverFactory> | undefined;

  return {
    name: "vinext:require-condition-resolution",
    enforce: "pre",
    configResolved(config) {
      resolveImport = createResolver(config, { isRequire: false });
      resolveRequire = createResolver(config, { isRequire: true });
    },
    resolveId(source) {
      if (virtualTargets.has(source)) return source;
    },
    async load(id) {
      const target = virtualTargets.get(id);
      if (!target) return;
      this.addWatchFile(target.file);
      try {
        return {
          code: await readFile(target.file, "utf8"),
          moduleType: target.moduleType,
        };
      } catch (error) {
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? Reflect.get(error, "code")
            : undefined;
        // Match Vite's filesystem loader: allow the normal load pipeline to
        // produce its contextual missing-file error for stale or proxy ids.
        if (code === "ENOENT" || code === "EISDIR") return;
        throw error;
      }
    },
    transform: {
      filter: { id: SCRIPT_MODULE_ID_RE, code: LITERAL_REQUIRE_RE },
      async handler(code, id) {
        const cleanId = stripViteModuleQuery(id);
        const commonjsDisposition = commonjsTransformFilter?.(cleanId);
        // Only pre-resolve calls that the following vite-plugin-commonjs pass
        // will turn into static imports. Ordinary dependencies and project
        // .cjs/.cts files are left to Vite/Rolldown, which already preserves
        // require conditions. Synthetic targets return true from the shared
        // filter so their nested conditional requires still recurse.
        if (
          commonjsDisposition === false ||
          (commonjsDisposition !== true && cleanId.includes("node_modules"))
        ) {
          return null;
        }
        const requires = collectLiteralRequires(code, id);
        if (requires.length === 0 || !resolveImport || !resolveRequire) return null;

        const output = new MagicString(code);
        let changed = false;
        // Synthetic script modules intentionally pass through this transform
        // again so nested package require() calls retain their own conditions.
        for (const { argument, specifier } of requires) {
          const [requireResolution, importResolution] = await Promise.all([
            resolveRequire(this.environment, specifier, id),
            resolveImport(this.environment, specifier, id),
          ]);
          if (
            !requireResolution ||
            requireResolution === specifier ||
            !path.isAbsolute(stripViteModuleQuery(requireResolution))
          ) {
            continue;
          }
          const requirePath = stripViteModuleQuery(requireResolution);
          const importPath = importResolution
            ? stripViteModuleQuery(importResolution)
            : importResolution;
          if (requirePath === importPath) continue;

          const moduleType = syntheticModuleType(requirePath);
          const virtualId = `${requirePath}.vinext-require.${moduleType}`;
          virtualTargets.set(virtualId, { file: requirePath, moduleType });
          output.overwrite(argument.start, argument.end, JSON.stringify(virtualId));
          changed = true;
        }
        if (!changed) return null;
        return magicStringTransformResult(output, { hires: "boundary", source: id });
      },
    },
  };
}
