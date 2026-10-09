import MagicString from "magic-string";
import { readFile } from "node:fs/promises";
import path from "pathslash";
import { createIdResolver, parseAst, type ESTree, type Plugin, type ResolvedConfig } from "vite";
import {
  collectBindingNames,
  forEachAstChild,
  isIdentifierNamed,
  SCRIPT_MODULE_ID_RE,
  scriptParserLanguage,
  staticStringValue,
  unwrapExpression,
} from "./ast-utils.js";
import { TRANSITIVE_EXTERNAL_META_KEY } from "./transitive-externals.js";
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
import { packageNameFromSpecifier } from "../utils/package-name.js";
import { canonicalizeFilePath, stripViteModuleQuery } from "../utils/path.js";

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

type BundlerExternal = NonNullable<ResolvedConfig["build"]["rolldownOptions"]>["external"];

// Mirror Rolldown's check of an import against `external`. It searches RegExp
// patterns without the stateful `g`/`y` flags, so match a copy rather than the
// user's (possibly frozen) RegExp.
function isBundlerExternal(
  external: BundlerExternal,
  id: string,
  importer: string,
  isResolved = false,
): boolean {
  if (typeof external === "function") return Boolean(external(id, importer, isResolved));
  const patterns = Array.isArray(external) ? external : [external];
  return patterns.some((pattern) => {
    if (typeof pattern === "string") return pattern === id;
    if (!(pattern instanceof RegExp)) return false;
    return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "")).test(id);
  });
}

function isAbsoluteResolution(resolution: string | undefined): resolution is string {
  return resolution !== undefined && path.isAbsolute(stripViteModuleQuery(resolution));
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
  getServerExternalPackages: () => readonly string[] = () => [],
): Plugin {
  // Vite reuses this plugin instance across its RSC, SSR, and client
  // environments, so the synthetic identity has to resolve in each graph.
  // Entries are keyed by the query-free resolved file path and are therefore
  // bounded by the distinct conditional package targets seen by the app.
  const virtualTargets = new Map<string, { file: string; moduleType: SyntheticModuleType }>();
  type ResolverPair = {
    require: ReturnType<IdResolverFactory>;
    import: ReturnType<IdResolverFactory>;
  };
  let defaultResolvers: ResolverPair | undefined;
  let bundlingResolvers: ResolverPair | undefined;
  // The bundler's final `external` option per build environment, including
  // entries other plugins add from their own `options` hooks.
  const bundlerExternals = new WeakMap<object, BundlerExternal>();

  return {
    name: "vinext:require-condition-resolution",
    enforce: "pre",
    options: {
      order: "post",
      handler(options) {
        if (this.environment) bundlerExternals.set(this.environment, options.external);
      },
    },
    configResolved(config) {
      defaultResolvers = {
        require: createResolver(config, { isRequire: true }),
        import: createResolver(config, { isRequire: false }),
      };
      // Server environments without `noExternal: true` (e.g. Nitro services)
      // externalize node_modules packages by default, and the id resolver then
      // returns the bare specifier. The static import that vite-plugin-commonjs
      // emits for it is later resolved with the `import` condition by the next
      // bundler or Node's ESM loader, so resolve to the real file here and
      // bundle the `require` target, as Next.js does for server dependencies.
      // Packages listed in `resolve.external` still take precedence.
      bundlingResolvers = {
        require: createResolver(config, { isRequire: true, noExternal: true }),
        import: createResolver(config, { isRequire: false, noExternal: true }),
      };
    },
    resolveId(source, importer, options) {
      if (virtualTargets.has(source)) return source;
      // Resolve a synthetic module's own imports from the file it stands for.
      // Vite resolves bare ids from the project root when the importer is not
      // a file on disk, which would pick a hoisted copy over a private one.
      const target = importer ? virtualTargets.get(stripViteModuleQuery(importer)) : undefined;
      if (target) return this.resolve(source, target.file, { ...options, skipSelf: true });
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
        // Resolve from the file a synthetic module stands for (see resolveId).
        const importer = virtualTargets.get(cleanId)?.file ?? id;
        if (requires.length === 0 || !defaultResolvers || !bundlingResolvers) return null;
        // `resolve.external: true` asks for every dependency to stay external,
        // so don't pull require targets into the bundle there.
        const keepExternals = this.environment.config.resolve.external === true;
        // Build-only: the dev module runner does not apply this option.
        const bundlerExternal =
          this.environment.config.command !== "build"
            ? undefined
            : bundlerExternals.has(this.environment)
              ? bundlerExternals.get(this.environment)
              : this.environment.config.build.rolldownOptions?.external;

        const output = new MagicString(code);
        let changed = false;
        // Synthetic script modules intentionally pass through this transform
        // again so nested package require() calls retain their own conditions.
        for (const { argument, specifier } of requires) {
          let [requireResolution, importResolution] = await Promise.all([
            defaultResolvers.require(this.environment, specifier, importer),
            defaultResolvers.import(this.environment, specifier, importer),
          ]);
          // The environment externalizes this package (the resolver returned
          // the bare id), so the call is pre-resolved by bundling its
          // `require` target instead.
          const bundlesExternal =
            !keepExternals &&
            requireResolution !== undefined &&
            !isAbsoluteResolution(requireResolution);
          if (bundlesExternal) {
            [requireResolution, importResolution] = await Promise.all([
              bundlingResolvers.require(this.environment, specifier, importer),
              bundlingResolvers.import(this.environment, specifier, importer),
            ]);
          }
          if (!isAbsoluteResolution(requireResolution)) continue;
          const requirePath = stripViteModuleQuery(requireResolution);
          const importPath = importResolution
            ? stripViteModuleQuery(importResolution)
            : importResolution;
          if (requirePath === importPath) continue;

          const moduleType = syntheticModuleType(requirePath);
          const virtualId = `${requirePath}.vinext-require.${moduleType}`;
          // Only take over an import that would otherwise just be externalized
          // by Vite: the hoisted import must resolve to the bare id, external,
          // with the package.json Vite's resolver found. A plugin that resolves
          // or externalizes it itself still wins. Vite drops that tag under
          // `legacy.inconsistentCjsInterop`, where its externalization cannot
          // be told apart from a plugin's, so the call is left alone there.
          //
          // Packages that Next.js keeps external on the server (its default
          // list, including native addons, plus `serverExternalPackages`) stay
          // external too. The exception is an importer-private copy, which
          // vinext:transitive-externals bundles from this importer's `import`
          // entry and marks in the resolution's `meta`; that one still needs
          // its `require` target. A plugin resolving the same file unmarked
          // still wins.
          //
          // A bundler external also wins when it matches the bare specifier,
          // the only id it tests once Vite externalizes the package, or the
          // synthetic id, which would become an import of a missing file.
          // (Vite's dev resolver returns the package entry, so only builds get
          // here.)
          if (bundlesExternal) {
            const resolved = await this.resolve(specifier, importer, { skipSelf: true });
            const packageName = packageNameFromSpecifier(specifier);
            const takesOver =
              packageName !== null && getServerExternalPackages().includes(packageName)
                ? resolved !== null &&
                  !resolved.external &&
                  resolved.meta?.[TRANSITIVE_EXTERNAL_META_KEY] === true &&
                  importPath !== undefined &&
                  canonicalizeFilePath(stripViteModuleQuery(resolved.id)) ===
                    canonicalizeFilePath(importPath)
                : Boolean(resolved?.external) &&
                  resolved?.id === specifier &&
                  resolved.packageJsonPath !== undefined;
            if (
              !takesOver ||
              (bundlerExternal !== undefined &&
                (isBundlerExternal(bundlerExternal, specifier, id) ||
                  isBundlerExternal(bundlerExternal, virtualId, id) ||
                  isBundlerExternal(bundlerExternal, virtualId, id, true)))
            ) {
              continue;
            }
          }
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
