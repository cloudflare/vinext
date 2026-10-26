import MagicString from "magic-string";
import { readFile } from "node:fs/promises";
import path from "pathslash";
import { createIdResolver, type Environment, type ESTree, type Plugin } from "vite";
import {
  collectBindingNames,
  forEachAstChild,
  isIdentifierNamed,
  parseProgramResult,
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
import { canNodeImport } from "./pages-node-externals.js";
import { magicStringTransformResult } from "./transform-result.js";
import { isPathInside, stripViteModuleQuery } from "../utils/path.js";

const LITERAL_REQUIRE_RE = /\brequire\s*\(/;
const CONDITIONAL_REQUIRE_SCRIPT_ID_RE = /\.vinext-require\.(?:js|jsx|ts|tsx)$/i;
const LOWERED_REQUIRE_PREFIX = "__vinext_require_";
const MODULE_KEYWORD_RE = /\b(?:import|export)\b/;
const SAME_PACKAGE_SPECIFIER_RE = /^[./#]/;
type LiteralRequire = {
  call: ESTree.CallExpression;
  argument: ESTree.Node;
  specifier: string;
  /**
   * Where the call runs: at module level, where it can await; in a class or
   * TypeScript namespace body, which cannot await but runs as the module
   * evaluates; or in a function.
   */
  context: RequireContext;
};

type RequireContext = "module" | "evaluation" | "function";

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

/** `require()` calls with one literal specifier whose `require` is not a local binding. */
function collectLiteralRequires(root: ESTree.Program): LiteralRequire[] {
  const requires: LiteralRequire[] = [];
  const rootScope = createAstScope(null);
  collectDirectScopeBindings(root, rootScope);
  collectVarScopeBindings(root, rootScope);

  function visit(node: ESTree.Node, parentScope: AstScope, context: RequireContext): void {
    let scope = parentScope;
    if (isFunctionNode(node)) {
      const parameterScope = createAstScope(parentScope);
      collectBindingNames(node.id, parameterScope.bindings);
      for (const parameter of node.params) {
        collectBindingNames(parameter, parameterScope.bindings);
        visit(parameter, parameterScope, "function");
      }

      const body = node.body;
      if (body) {
        const bodyScope = createAstScope(parameterScope);
        collectDirectScopeBindings(body, bodyScope);
        collectVarScopeBindings(body, bodyScope);
        if (body.type === "BlockStatement") {
          for (const statement of body.body) visit(statement, bodyScope, "function");
        } else {
          visit(body, bodyScope, "function");
        }
      }
      return;
    }

    if (node.type === "SwitchStatement") {
      visit(node.discriminant, parentScope, context);
      const switchScope = createAstScope(parentScope);
      collectSwitchScopeBindings(node, switchScope);
      for (const switchCase of node.cases) visit(switchCase, switchScope, context);
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
        specifier !== null
      ) {
        requires.push({ call: node, argument, specifier, context });
        return;
      }
    }

    // An instance field's value runs when the class is constructed.
    if (
      (node.type === "PropertyDefinition" || node.type === "AccessorProperty") &&
      !node.static &&
      node.value
    ) {
      const value = node.value;
      forEachAstChild(node, (child) => visit(child, scope, child === value ? "function" : context));
      return;
    }

    // Class fields and static blocks cannot await; TypeScript compiles
    // namespace and enum bodies to functions.
    const childContext =
      context === "module" &&
      (node.type === "ClassBody" ||
        node.type === "TSModuleBlock" ||
        node.type === "TSEnumDeclaration")
        ? "evaluation"
        : context;
    forEachAstChild(node, (child) => visit(child, scope, childContext));
  }

  for (const statement of root.body) visit(statement, rootScope, "module");
  return requires;
}

/**
 * Whether a module is a dependency that a dev server environment's module
 * runner evaluates as it is, where an ES module has no `require`: one the
 * dependency optimizer does not bundle into its cache directory, such as one of
 * the packages with a `react` peer dependency that @vitejs/plugin-rsc excludes
 * from it.
 */
function isUnbundledServerDependency(environment: Environment, file: string): boolean {
  return (
    environment.mode === "dev" &&
    environment.config.dev.moduleRunnerTransform === true &&
    !isPathInside(environment.config.cacheDir, file) &&
    // Vitest's module runner defines `require` in the modules it evaluates.
    !environment.config.plugins.some((plugin) => plugin.name.startsWith("vitest:"))
  );
}

/**
 * Lower `require()` calls in an unbundled ESM dependency the way
 * @vitejs/plugin-rsc lowers them in the CommonJS dependencies it converts for
 * the module runner, with its interop for the result. A module-level call
 * awaits `import()` in place, so statements keep their order and a call that
 * never runs never loads. A call inside a function cannot await, so its target
 * loads ahead of the call, and a load error is thrown by the call rather than
 * by the module, as `try`/`catch` around the call expects. A package or
 * builtin loads when the module starts to evaluate, so a function the module
 * calls while evaluating, such as a bundled `__commonJS` wrapper, can require
 * it, and so does anything a class's static members or a namespace body
 * require. A file of the same package that only functions and instance fields
 * require loads after the module has
 * evaluated: such a lazy `require()` usually breaks an import cycle, and
 * loading it first would evaluate the cycle before this module's bindings
 * exist. Code is inserted without newlines before the end, keeping line
 * numbers.
 */
function lowerRequires(
  code: string,
  program: ESTree.Program,
  requires: LiteralRequire[],
): MagicString {
  let prefix = LOWERED_REQUIRE_PREFIX;
  while (code.includes(prefix)) prefix += "$";
  const interop = `${prefix}_`;
  const load = `${prefix}load__`;
  const output = new MagicString(code);
  // Same-package files that only functions require load after the module.
  const loadsLast = new Set(
    requires.flatMap(({ specifier }) =>
      SAME_PACKAGE_SPECIFIER_RE.test(specifier) ? [specifier] : [],
    ),
  );
  for (const { specifier, context } of requires) {
    if (context === "evaluation") loadsLast.delete(specifier);
  }
  const hoisted = new Map<string, string>();
  let deferred = "";
  for (const { call, argument, specifier, context } of requires) {
    const target = code.slice(argument.start, argument.end);
    if (context === "module") {
      output.update(call.start, argument.start, `${interop}(await import(`);
      output.update(argument.end, call.end, "))");
      continue;
    }
    let name = hoisted.get(specifier);
    if (!name) {
      name = `${prefix}${hoisted.size}__`;
      hoisted.set(specifier, name);
      const declaration = `const ${name} = await ${load}(import(${target}));`;
      if (loadsLast.has(specifier)) deferred += `\n${declaration}`;
      else output.appendLeft(hoistPosition(code, program), declaration);
    }
    output.update(call.start, call.end, `${name}()`);
  }
  // @vitejs/plugin-rsc's `__cjs_interop__`: a namespace is `module.exports`'s
  // wrapper when plugin-rsc converted it or its default export holds every
  // other export, as Node's CommonJS and builtin namespaces do. A
  // "module.exports" export is what Node's require() returns, which Node 24
  // also adds to the namespaces of CommonJS it imports.
  output.append(
    deferred +
      `\nfunction ${interop}(m) { if ("module.exports" in m) return m["module.exports"]; return m.__cjs_module_runner_transform || ("default" in m && Object.keys(m).every((k) => k === "default" || m[k] === m.default?.[k])) ? m.default : m; }` +
      (hoisted.size > 0
        ? `\nfunction ${load}(load) { return load.then((m) => () => ${interop}(m), (error) => () => { throw error; }); }`
        : ""),
  );
  return output;
}

/** Where hoisted loads go: after the hashbang and directive prologue, before decorators. */
function hoistPosition(code: string, program: ESTree.Program): number {
  const statement = program.body.find(
    (node) => node.type !== "ExpressionStatement" || typeof node.directive !== "string",
  );
  if (!statement) return code.length;
  // `@dec export class A {}` keeps its decorators on the exported class, which
  // starts after them; a class statement already starts at its first decorator.
  const declaration = "declaration" in statement ? statement.declaration : null;
  const decorators =
    declaration && "decorators" in declaration ? (declaration.decorators ?? []) : [];
  return Math.min(statement.start, ...decorators.map((decorator) => decorator.start));
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
        if (commonjsDisposition === false) return null;
        if (commonjsDisposition !== true && cleanId.includes("node_modules")) {
          if (!isUnbundledServerDependency(this.environment, cleanId)) return null;
          // Lower only the ES modules @vitejs/plugin-rsc leaves as they are. It
          // converts a `.js` file without module syntax outside a
          // `"type": "module"` package as CommonJS; the module runner evaluates
          // every other file as ESM. Most CommonJS never mentions `import` or
          // `export`, so it skips the parse, and the module record rules out the
          // rest before their AST is read.
          if (/\.c[jt]s$/i.test(cleanId)) return null;
          const lang = scriptParserLanguage(id) ?? "jsx";
          let parsed = MODULE_KEYWORD_RE.test(code)
            ? parseProgramResult(code, { lang })
            : undefined;
          // `null` is a syntax error: leave the file to Vite.
          if (parsed === null) return null;
          if (!parsed?.module.hasModuleSyntax) {
            if (/\.js$/i.test(cleanId) && !canNodeImport(cleanId)) return null;
            parsed ??= parseProgramResult(code, { lang });
          }
          if (!parsed) return null;
          const requires = collectLiteralRequires(parsed.program);
          if (requires.length === 0) return null;
          return magicStringTransformResult(lowerRequires(code, parsed.program, requires), {
            hires: "boundary",
            source: id,
          });
        }
        const parsed = parseProgramResult(code, { lang: scriptParserLanguage(id) ?? "jsx" });
        const requires = parsed
          ? collectLiteralRequires(parsed.program).filter(({ specifier }) =>
              isPackageSpecifier(specifier),
            )
          : [];
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
