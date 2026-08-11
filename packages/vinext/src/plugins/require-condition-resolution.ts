import MagicString from "magic-string";
import { readFile } from "node:fs/promises";
import path from "pathslash";
import { createIdResolver, parseAst, type Plugin } from "vite";
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
  createAstScope,
  hasAstBinding,
  isFunctionNode,
  type AstScope,
} from "./ast-scope.js";
import { stripViteModuleQuery } from "../utils/path.js";

const TRANSFORMABLE_ID_RE = /\.(?:[cm]?[jt]s|[jt]sx)(?:\?.*)?$/i;
const LITERAL_REQUIRE_RE = /\brequire\s*\(/;
const CONDITIONAL_REQUIRE_SCRIPT_ID_RE = /\.vinext-require\.(?:js|jsx|ts|tsx)$/i;
const TRANSPARENT_EXPRESSIONS = new Set([
  "ChainExpression",
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSInstantiationExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
]);

type LiteralRequire = {
  argument: AstRecord & { start: number; end: number };
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

function parserLanguage(id: string): "js" | "jsx" | "ts" | "tsx" {
  const cleanId = id.split("?", 1)[0].toLowerCase();
  if (cleanId.endsWith(".tsx")) return "tsx";
  if (cleanId.endsWith(".ts") || cleanId.endsWith(".mts") || cleanId.endsWith(".cts")) {
    return "ts";
  }
  return "jsx";
}

function unwrapExpression(value: unknown): AstRecord | null {
  const node = isAstRecord(value) ? value : null;
  if (!node || !TRANSPARENT_EXPRESSIONS.has(node.type)) return node;
  return unwrapExpression(node.expression);
}

function literalString(value: unknown): string | null {
  const node = unwrapExpression(value);
  if (
    (node?.type === "Literal" || node?.type === "StringLiteral") &&
    typeof node.value === "string"
  ) {
    return node.value;
  }
  if (node?.type !== "TemplateLiteral" || nodeArray(node.expressions).length !== 0) return null;
  const quasiCandidate = nodeArray(node.quasis)[0];
  const quasi = isAstRecord(quasiCandidate) ? quasiCandidate : null;
  const quasiValue = quasi && typeof quasi.value === "object" ? quasi.value : null;
  if (!quasiValue) return null;
  const cooked = Reflect.get(quasiValue, "cooked");
  const raw = Reflect.get(quasiValue, "raw");
  return typeof cooked === "string" ? cooked : typeof raw === "string" ? raw : null;
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
    ast = parseAst(code, { lang: parserLanguage(id) });
  } catch {
    return [];
  }

  const root = isAstRecord(ast) ? ast : null;
  if (!root) return [];
  const requires: LiteralRequire[] = [];
  const rootScope = createAstScope(null);
  collectDirectScopeBindings(root, rootScope);
  collectVarScopeBindings(root, rootScope);

  function visit(node: AstRecord, parentScope: AstScope): void {
    let scope = parentScope;
    if (isFunctionNode(node)) {
      const parameterScope = createAstScope(parentScope);
      collectBindingNames(node.id, parameterScope.bindings);
      for (const parameter of nodeArray(node.params)) {
        collectBindingNames(parameter, parameterScope.bindings);
        if (isAstRecord(parameter)) visit(parameter, parameterScope);
      }

      const body = isAstRecord(node.body) ? node.body : null;
      if (body) {
        const bodyScope = createAstScope(parameterScope);
        collectDirectScopeBindings(body, bodyScope);
        collectVarScopeBindings(body, bodyScope);
        if (body.type === "BlockStatement") {
          for (const statement of nodeArray(body.body)) {
            if (isAstRecord(statement)) visit(statement, bodyScope);
          }
        } else {
          visit(body, bodyScope);
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

    if (
      (node.type === "BlockStatement" && node !== root) ||
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
      const args = nodeArray(node.arguments);
      const argument = unwrapExpression(args[0]);
      const specifier = literalString(argument);
      if (
        isIdentifierNamed(callee, "require") &&
        !hasAstBinding(scope, "require") &&
        args.length === 1 &&
        argument &&
        hasRange(argument) &&
        specifier !== null &&
        isPackageSpecifier(specifier)
      ) {
        requires.push({ argument, specifier });
        return;
      }
    }

    forEachAstChild(node, (child) => visit(child, scope));
  }

  for (const statement of nodeArray(root.body)) {
    if (isAstRecord(statement)) visit(statement, rootScope);
  }
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

export function createRequireConditionResolutionPlugin(
  createResolver: IdResolverFactory = createIdResolver,
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
      filter: { id: TRANSFORMABLE_ID_RE, code: LITERAL_REQUIRE_RE },
      async handler(code, id) {
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
        return {
          code: output.toString(),
          map: output.generateMap({ hires: "boundary", source: id }),
        };
      },
    },
  };
}
