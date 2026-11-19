import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "pathslash";
import type { ESTree, Plugin } from "vite";
import { packageNameFromSpecifier } from "../utils/package-name.js";
import type { NitroTracedExternals } from "../build/nitro-trace-deps.js";
import { canonicalizeFilePath, stripViteModuleQuery } from "../utils/path.js";
import { escapeRegExp } from "../utils/regex.js";
import {
  collectBindingNames,
  getAstName,
  isIdentifierNamed,
  parseProgram,
  SCRIPT_MODULE_ID_RE,
  scriptParserLanguage,
  staticStringValue,
  unwrapExpression,
  walkAst,
} from "./ast-utils.js";

// Code that may load or resolve a package outside Nitro's view.
const REQUIRE_CODE_RE = /\bcreateRequire\b|\brequire\.resolve\b/;
const TRACE_QUERY = "?vinext-nitro-trace=";
const TRACE_MODULE_RE = /\?vinext-nitro-trace=/;

const isNodeModuleSource = (value: unknown) => value === "module" || value === "node:module";

// How many declarations in the module bind each name, in any scope.
function declarationCounts(program: ESTree.Program): Map<string, number> {
  const counts = new Map<string, number>();
  const declare = (node: ESTree.Node | null | undefined) => {
    const names = new Set<string>();
    collectBindingNames(node, names);
    for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  };
  walkAst(program, (node) => {
    // Only declarations can bind a name.
    // oxlint-disable-next-line typescript/switch-exhaustiveness-check
    switch (node.type) {
      case "VariableDeclarator":
        declare(node.id);
        break;
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        if ("id" in node) declare(node.id);
        for (const param of node.params) declare(param);
        break;
      case "ClassDeclaration":
      case "ClassExpression":
        declare(node.id);
        break;
      case "CatchClause":
        declare(node.param);
        break;
      case "ImportDeclaration":
        for (const specifier of node.specifiers) declare(specifier.local);
        break;
      default:
        break;
    }
  });
  return counts;
}

// Static specifiers loaded or resolved by a `require` the bundler doesn't follow:
// - calls on a `require` made with `node:module`'s `createRequire()`, inline or
//   through a binding: `createRequire(url)("pkg")`, `const r = createRequire(url); r("pkg")`,
//   `const r = module.createRequire(url)`, and their `.resolve("pkg")`. `node:module`
//   may be imported or `require()`d;
// - `require.resolve("pkg")`, unless the module declares its own `require`.
// Without scope analysis, a binding that any other declaration in the module
// shadows is skipped.
function requireSpecifiers(
  code: string,
  id: string,
): { specifiers: string[]; isModule: boolean } | null {
  const lang = scriptParserLanguage(id);
  if (!lang) return null;
  let program: ESTree.Program;
  try {
    program = parseProgram(code, { lang });
  } catch {
    return null;
  }
  const counts = declarationCounts(program);
  const declaredOnce = (name: string) => counts.get(name) === 1;
  const globalRequire = !counts.has("require");
  const isNodeModuleRequire = (node: ESTree.Node | null | undefined): boolean => {
    const call = unwrapExpression(node);
    return (
      globalRequire &&
      call?.type === "CallExpression" &&
      isIdentifierNamed(unwrapExpression(call.callee), "require") &&
      isNodeModuleSource(staticStringValue(call.arguments[0] as ESTree.Node | undefined))
    );
  };

  // Local names of `createRequire` and of `node:module` namespaces.
  const createRequireNames = new Set<string>();
  const moduleNames = new Set<string>();
  let isModule = false;
  for (const statement of program.body) {
    if (statement.type.startsWith("Export")) isModule = true;
    if (statement.type !== "ImportDeclaration") continue;
    isModule = true;
    if (!isNodeModuleSource(statement.source.value)) continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type !== "ImportSpecifier") moduleNames.add(specifier.local.name);
      else if (getAstName(specifier.imported) === "createRequire") {
        createRequireNames.add(specifier.local.name);
      }
    }
  }
  // `const module = require("node:module")`, `const { createRequire } = require("module")`.
  walkAst(program, (node) => {
    if (node.type !== "VariableDeclarator" || !isNodeModuleRequire(node.init)) return;
    if (node.id.type === "Identifier") moduleNames.add(node.id.name);
    if (node.id.type !== "ObjectPattern") return;
    for (const property of node.id.properties) {
      if (
        property.type === "Property" &&
        getAstName(property.key) === "createRequire" &&
        property.value.type === "Identifier"
      ) {
        createRequireNames.add(property.value.name);
      }
    }
  });

  const isModuleNamespace = (node: ESTree.Node | null): boolean => {
    const target = unwrapExpression(node);
    return (
      (target?.type === "Identifier" &&
        moduleNames.has(target.name) &&
        declaredOnce(target.name)) ||
      isNodeModuleRequire(target)
    );
  };
  const isCreateRequireCall = (node: ESTree.Node | null): boolean => {
    const call = unwrapExpression(node);
    if (call?.type !== "CallExpression") return false;
    const callee = unwrapExpression(call.callee);
    if (callee?.type === "Identifier") {
      return createRequireNames.has(callee.name) && declaredOnce(callee.name);
    }
    return (
      callee?.type === "MemberExpression" &&
      isModuleNamespace(callee.object) &&
      getAstName(callee.property) === "createRequire"
    );
  };
  const requireNames = new Set<string>();
  walkAst(program, (node) => {
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      declaredOnce(node.id.name) &&
      isCreateRequireCall(node.init)
    ) {
      requireNames.add(node.id.name);
    }
  });
  const isRequire = (node: ESTree.Node | null): boolean => {
    const target = unwrapExpression(node);
    return (
      isCreateRequireCall(target) ||
      (target?.type === "Identifier" && requireNames.has(target.name))
    );
  };
  const specifiers: string[] = [];
  walkAst(program, (node) => {
    if (node.type !== "CallExpression") return;
    const callee = unwrapExpression(node.callee);
    const loads =
      isRequire(callee) ||
      (callee?.type === "MemberExpression" &&
        getAstName(callee.property) === "resolve" &&
        (isRequire(callee.object) ||
          (globalRequire && isIdentifierNamed(unwrapExpression(callee.object), "require"))));
    if (!loads) return;
    const specifier = staticStringValue(node.arguments[0] as ESTree.Node | undefined);
    if (specifier) specifiers.push(specifier);
  });
  return { specifiers, isModule };
}

// A `require()` per specifier that never runs.
function traceOnlyRequires(specifiers: Iterable<string>): string {
  return [...specifiers]
    .sort()
    .map(
      (specifier) =>
        `if (globalThis.__VINEXT_NITRO_TRACE_ONLY__) require(${JSON.stringify(specifier)});\n`,
    )
    .join("");
}

function resolveFrom(file: string, specifier: string): string | null {
  try {
    return canonicalizeFilePath(createRequire(file).resolve(specifier));
  } catch {
    return null;
  }
}

// The id a marker requires. Nitro resolves it without extension probing, so a
// subpath of a package without `exports` names the resolved file instead, as
// Vite rewrites a `require()` of it: `aws-sdk/clients/s3` -> `aws-sdk/clients/s3.js`.
function markerSpecifier(
  file: string,
  specifier: string,
  packageName: string,
  resolved: string,
): string {
  if (specifier === packageName) return specifier;
  const manifestPath = resolveFrom(file, `${packageName}/package.json`);
  if (!manifestPath) return specifier;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { exports?: unknown };
    if (manifest.exports !== undefined) return specifier;
  } catch {
    return specifier;
  }
  return `${packageName}/${path.relative(path.dirname(manifestPath), resolved)}`;
}

// Whether the module's rendered (tree-shaken) code still calls something with
// `specifier`, as its `require` call renders: `__require("pkg")`, `load?.("pkg")`.
function rendersRequireCall(code: string, specifier: string): boolean {
  const quoted = escapeRegExp(specifier);
  return new RegExp(`[\\w$)\\]]\\s*(?:\\?\\.\\s*)?\\(\\s*(["'\`])${quoted}\\1\\s*[,)]`).test(code);
}

/**
 * vinext:nitro-required-externals
 *
 * Nitro copies the server externals its server bundle imports into
 * `.output/server/node_modules`. A `require()` of an external from CommonJS
 * code bundled into vinext's server environments is emitted as a call on
 * `createRequire(import.meta.url)` instead, as is an explicit `createRequire`
 * call, so Nitro never sees it and the package is missing at runtime. Nor does
 * it see `require.resolve()`. Next.js output file tracing follows all of these.
 *
 * For each external such a call in a chunk still loads, this appends a
 * `require()` that never runs, so Nitro resolves it with the same `require`
 * conditions and traces and copies the package like an imported one. A call
 * that tree-shaking removed is skipped, as is one whose package isn't
 * installed (an optional `try { require("x") } catch {}`) or resolves to a
 * nested copy, which Nitro can't resolve from the chunk.
 *
 * Dependencies the server environments keep external (App Router) are bundled
 * by Nitro's own environment, which sees `require()` but not `createRequire`
 * or `require.resolve()` calls. There an ES module imports the marker as a
 * virtual module under its own path, so packages resolve from it and a local
 * `require` binding can't shadow it; a CommonJS module, whose `require` isn't
 * shadowed, gets the marker appended. Nitro traces what it resolves, before
 * tree-shaking, as it does for imports.
 */
export function createNitroRequiredExternalsPlugin(options: {
  isEnabled: () => boolean;
  /** The server externals Nitro traces. */
  getTracedExternals: () => NitroTracedExternals;
  /** Whether a module Nitro bundles is vinext's own server environment output. */
  isNitroServiceOutput: (id: string) => boolean;
}): Plugin {
  // Installed server externals each module loads with `require()`: specifier to marker id.
  const requiredByModule = new Map<string, Map<string, string>>();
  // The appended code moves nothing, so the existing sourcemap still applies.
  const appended = (code: string, extra: string) => ({ code: `${code}\n${extra}`, map: null });

  // The hooks for one environment, filtered to the traced package names.
  const environmentPlugin = (environmentName: string, traced: NitroTracedExternals): Plugin => {
    const names = [...traced.packages].map(escapeRegExp).join("|");
    const tracedSpecifierRe = new RegExp(`^(?:${names})(?:/|$)`);
    // Code that may name a traced package in a string.
    const tracedNameRe = new RegExp(`["'\`](?:${names})["'\`/]`);
    const mayRequireTraced = (code: string) =>
      REQUIRE_CODE_RE.test(code) && tracedNameRe.test(code);

    // The marker id for `specifier` if it loads a traced package that `importer`
    // resolves. With `resolveDir`, it must also resolve to the same file from there.
    const tracedMarker = (importer: string, specifier: string, resolveDir?: string) => {
      const packageName = packageNameFromSpecifier(specifier);
      if (!packageName || !traced.packages.has(packageName)) return null;
      const file = stripViteModuleQuery(importer);
      if (!path.isAbsolute(file)) return null;
      const resolved = resolveFrom(file, specifier);
      if (resolved === null) return null;
      if (
        resolveDir !== undefined &&
        resolved !== resolveFrom(path.join(resolveDir, "package.json"), specifier)
      ) {
        return null;
      }
      // Nitro only traces a package under `node_modules/<name>`, not a linked
      // workspace package, and would bundle a marked one into a branch that never
      // runs. So would a `noExternals` entry.
      if (!resolved.includes(`/node_modules/${packageName}/`)) return null;
      const marker = markerSpecifier(file, specifier, packageName, resolved);
      if (traced.bundles(marker) || traced.bundles(resolved)) return null;
      return marker;
    };

    if (environmentName === "nitro") {
      return {
        name: "vinext:nitro-required-externals:nitro",
        resolveId: {
          filter: { id: TRACE_MODULE_RE },
          handler: (source) => source,
        },
        load: {
          filter: { id: TRACE_MODULE_RE },
          handler(id) {
            const encoded = id.slice(id.indexOf(TRACE_QUERY) + TRACE_QUERY.length);
            return traceOnlyRequires(JSON.parse(decodeURIComponent(encoded)) as string[]);
          },
        },
        transform: {
          filter: { id: SCRIPT_MODULE_ID_RE, code: REQUIRE_CODE_RE },
          handler(code, id) {
            const file = stripViteModuleQuery(id);
            if (TRACE_MODULE_RE.test(id) || !mayRequireTraced(code)) return;
            if (options.isNitroServiceOutput(file)) return;
            const found = requireSpecifiers(code, id);
            const required = new Set<string>();
            for (const specifier of found?.specifiers ?? []) {
              const marker = tracedMarker(id, specifier);
              if (marker) required.add(marker);
            }
            if (!found || required.size === 0) return;
            if (!found.isModule) return appended(code, traceOnlyRequires(required));
            const traceModule = `${file}${TRACE_QUERY}${encodeURIComponent(JSON.stringify([...required]))}`;
            return appended(code, `import ${JSON.stringify(traceModule)};`);
          },
        },
      };
    }

    const record = (resolveDir: string, importer: string, specifier: string) => {
      const marker = tracedMarker(importer, specifier, resolveDir);
      if (!marker) return;
      let specifiers = requiredByModule.get(importer);
      if (!specifiers) requiredByModule.set(importer, (specifiers = new Map()));
      specifiers.set(specifier, marker);
    };
    // Nitro resolves a `renderChunk` marker from where the chunk is written.
    const outputDir = (environment: { config: { root: string; build: { outDir: string } } }) =>
      path.resolve(environment.config.root, environment.config.build.outDir);
    // plugin-rsc's scan builds write nothing.
    const isScanBuild = (environment: { config: { build: { write?: boolean } } }) =>
      environment.config.build.write === false;
    return {
      name: "vinext:nitro-required-externals",
      resolveId: {
        // Before Vite's resolver claims the bare specifier.
        order: "pre",
        filter: { id: tracedSpecifierRe },
        handler(source, importer, resolveOptions) {
          if (
            importer &&
            resolveOptions.kind === "require-call" &&
            !isScanBuild(this.environment)
          ) {
            record(outputDir(this.environment), importer, source);
          }
          return null;
        },
      },
      transform: {
        filter: { id: SCRIPT_MODULE_ID_RE, code: REQUIRE_CODE_RE },
        handler(code, id) {
          if (isScanBuild(this.environment) || !mayRequireTraced(code)) return;
          const dir = outputDir(this.environment);
          for (const specifier of requireSpecifiers(code, id)?.specifiers ?? []) {
            record(dir, id, specifier);
          }
        },
      },
      renderChunk(code, chunk) {
        const required = new Set<string>();
        for (const id of chunk.moduleIds) {
          const specifiers = requiredByModule.get(id);
          // Rendered code is copied out of Rolldown on each read.
          const renderedCode = specifiers && chunk.modules[id]?.code;
          if (!renderedCode) continue;
          for (const [specifier, marker] of specifiers) {
            // Vite renders an external `require()` of a subpath as the marker id.
            if (
              rendersRequireCall(renderedCode, specifier) ||
              rendersRequireCall(renderedCode, marker)
            ) {
              required.add(marker);
            }
          }
        }
        if (required.size === 0) return null;
        // Rolldown renames chunk-level bindings named `require`, so this is the global.
        return appended(code, traceOnlyRequires(required));
      },
    };
  };

  return {
    name: "vinext:nitro-required-externals:setup",
    apply: "build",
    // Read after every Nitro module's setup, which runs in Nitro's `config` hook.
    applyToEnvironment(environment) {
      if (
        environment.name !== "rsc" &&
        environment.name !== "ssr" &&
        environment.name !== "nitro"
      ) {
        return false;
      }
      if (!options.isEnabled()) return false;
      const traced = options.getTracedExternals();
      if (traced.packages.size === 0) return false;
      return environmentPlugin(environment.name, traced);
    },
  };
}
