// Rewrites module-identity globals so they survive bundling with a portable
// server-runtime policy:
//   - project-source `import.meta.url` reads become source-module URLs
//   - dependency `import.meta.url` reads use source identity while unbundled
//     and emitted-chunk identity once bundled
//   - server-side free `__filename` / `__dirname` reads become the emitted
//     module path once bundled (or the native source path when unbundled)
//
// Two known limitations, both matching Vite's own `import.meta.url` handling:
//   1. Destructured access — `const { url } = import.meta;` — is not detected
//      and will leak the bundled chunk URL.
//   2. An aliased `import.meta.url` used as a `new URL()` base — e.g.
//      `const u = import.meta.url; new URL("./file", u);` — is rewritten,
//      breaking Vite's asset detection for that expression. Only the direct
//      `new URL("./file", import.meta.url)` form is preserved.
// Both are edge cases that are unlikely in real Next.js apps.
//
// Next.js/Webpack bakes dependency source URLs into server bundles. Vinext
// deliberately uses emitted identity for bundled dependencies instead: source
// paths do not exist in Workers and must not leak from the build host, while an
// emitted URL remains meaningful after relocating Node and Nitro output.
import { parseAst, type Plugin, type ResolvedConfig } from "vite";
import MagicString from "magic-string";
import path, { toSlash } from "pathslash";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalizeFilePath, isPathInsideOrEqual, stripViteModuleQuery } from "../utils/path.js";
import { VIRTUAL_MODULE_ID_RE, VIRTUAL_PREFIX } from "../utils/virtual-module.js";
import {
  collectBindingNames,
  forEachAstChild,
  hasRange,
  isAstRecord,
  isIdentifierNamed,
  nodeArray,
  SCRIPT_MODULE_ID_RE,
  scriptParserLanguage,
  type AstRange,
  type AstRecord,
} from "./ast-utils.js";
import { magicStringTransformResult, type MagicStringTransformResult } from "./transform-result.js";

type ImportMetaUrlEnvironment = "client" | "server";
type ModuleIdentityTransformKind =
  | "client"
  | "server-dev"
  | "server-build"
  | "server-cjs-dev"
  | "server-cjs-build";

type RootPaths = {
  root: string;
  canonicalRoot: string;
  excludedRelativePrefixes: string[];
};

type ImportMetaUrlCacheEntry = {
  source: string;
  canonicalRoot: string;
  canonicalId: string;
  results: Map<ModuleIdentityTransformKind, { value: MagicStringTransformResult | null }>;
};

type DependencyModuleCacheEntry = {
  canonicalRoot: string | undefined;
  value: { canonicalId: string; isCommonJs: boolean } | null;
};

export type ImportMetaUrlCapability = {
  /** The Vite app plugin. Owns project, dependency, and emitted-chunk identity. */
  vitePlugin: Plugin;
  /** Thin adapter for Vite's independent dependency-optimizer Rolldown pipeline. */
  optimizeDepsPlugin: Plugin;
  /** Cached dependency identity/format classifier shared by both plugin pipelines. */
  isBundledCommonJsDependencyId: (id: string) => boolean;
};

export type EmittedModuleFileNameResolver = (
  environmentName: string | undefined,
  fileName: string,
) => string;

const MAX_DEPENDENCY_FORMAT_CACHE_ENTRIES = 512;
const MAX_TRANSFORM_CACHE_ENTRIES = 2_048;

// This block-comment expression cannot span an earlier closing delimiter. Keep
// it deterministic: this regex runs in native hook filters and the JS fast
// guard, so nested repetition around a lazy `.*?` would permit exponential
// backtracking on repeated comments followed by a near-match.
const BLOCK_COMMENT_PATTERN = String.raw`\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\/`;
const JAVASCRIPT_TRIVIA_PATTERN = String.raw`(?:\s|${BLOCK_COMMENT_PATTERN}|\/\/[^\r\n\u2028\u2029]*)*`;
const UNICODE_IDENTIFIER_ESCAPE_PATTERN = String.raw`\\u(?:[\dA-Fa-f]{4}|\{[\dA-Fa-f]+\})`;
const IMPORT_META_URL_CANDIDATE_PATTERN = String.raw`\bimport${JAVASCRIPT_TRIVIA_PATTERN}\.${JAVASCRIPT_TRIVIA_PATTERN}meta${JAVASCRIPT_TRIVIA_PATTERN}\??\.${JAVASCRIPT_TRIVIA_PATTERN}(?:u|${UNICODE_IDENTIFIER_ESCAPE_PATTERN})(?:r|${UNICODE_IDENTIFIER_ESCAPE_PATTERN})(?:l|${UNICODE_IDENTIFIER_ESCAPE_PATTERN})`;
const IMPORT_META_URL_CANDIDATE_RE = new RegExp(IMPORT_META_URL_CANDIDATE_PATTERN, "u");
const SOURCE_IDENTITY_FILTER_RE = new RegExp(
  `${IMPORT_META_URL_CANDIDATE_PATTERN}|__filename|__dirname`,
  "u",
);
export function createImportMetaUrlPlugin(options: {
  getRoot: () => string | undefined;
  createEmittedModuleFileNameResolver?: (
    config: ResolvedConfig,
  ) => EmittedModuleFileNameResolver | undefined;
}): ImportMetaUrlCapability {
  let rootPaths: RootPaths | undefined;
  let outputDirs: string[] = [];
  let resolveEmittedModuleFileName: EmittedModuleFileNameResolver = (_, fileName) => fileName;
  // Keep path dependencies as separate equality fields so cache hits avoid
  // allocating and hashing a composite string containing both full paths.
  // Replacing the entry also bounds each raw id to one source/path combination.
  const transformCache = new Map<string, ImportMetaUrlCacheEntry>();
  // Canonical dependency paths and package metadata are immutable for the lifetime of a Vite config. A config
  // restart creates a new capability and cache, so package.json edits are not
  // retained across restarts. Cap the rare token-bearing dependency set to
  // avoid retaining arbitrary ids from long-running dev servers.
  const dependencyModuleCache = new Map<string, DependencyModuleCacheEntry>();
  // Raw CommonJS cannot contain import.meta before Rolldown lowers it. Keep
  // private per-capability string literals behind own getters, then replace
  // only those return values after lowering. Unlike a bare literal, a marker
  // cannot fold into a surrounding `__dirname + "/file"` expression or a
  // `fileURLToPath(import.meta.url)` call.
  // The fixed-size provenance state stays valid for cached transforms and every
  // output of the capability.
  const emittedModuleIdentity = createEmittedModuleIdentity();
  function dependencyModule(id: string): DependencyModuleCacheEntry["value"] {
    const cleanId = stripViteModuleQuery(id);
    const paths = getRootPaths();
    const cached = dependencyModuleCache.get(cleanId);
    if (cached && cached.canonicalRoot === paths?.canonicalRoot) {
      return cached.value;
    }
    const dependency = canonicalDependencyModuleId(cleanId, paths);
    const result =
      dependency === null
        ? null
        : {
            canonicalId: dependency.canonicalId,
            isCommonJs: isCommonJsDependency(dependency.canonicalId, dependency.allowUnpackaged),
          };
    setBoundedCacheEntry(
      dependencyModuleCache,
      cleanId,
      { canonicalRoot: paths?.canonicalRoot, value: result },
      MAX_DEPENDENCY_FORMAT_CACHE_ENTRIES,
    );
    return result;
  }
  function commonJsDependencyCanonicalId(id: string): string | null {
    const dependency = dependencyModule(id);
    return dependency?.isCommonJs ? dependency.canonicalId : null;
  }

  function getRootPaths(): RootPaths | undefined {
    const root = options.getRoot();
    if (!root) return rootPaths;
    if (!rootPaths || rootPaths.root !== root) {
      rootPaths = createRootPaths(root, { outputDirs });
    }
    return rootPaths;
  }

  const vitePlugin: Plugin = {
    name: "vinext:import-meta-url",
    enforce: "post",
    configResolved(config) {
      const root = options.getRoot() ?? config.root;
      const environments = Object.entries(config.environments ?? {});
      outputDirs = [
        config.build.outDir,
        ...environments.map(([, environment]) => environment.build.outDir),
      ];
      resolveEmittedModuleFileName =
        options.createEmittedModuleFileNameResolver?.(config) ?? ((_, fileName) => fileName);
      rootPaths = createRootPaths(root, { outputDirs });
    },
    watchChange() {
      // Package scope and symlink targets can change while a dev server stays
      // alive. The next rare CJS-global-bearing dependency reclassifies from
      // disk; ordinary transforms still use the cache between watch events.
      dependencyModuleCache.clear();
    },
    transform: {
      filter: {
        id: {
          include: SCRIPT_MODULE_ID_RE,
          exclude: VIRTUAL_MODULE_ID_RE,
        },
        code: SOURCE_IDENTITY_FILTER_RE,
      },
      handler(code, id) {
        // Keep this before module-id canonicalization and package-scope work.
        // The native code filter normally handles this, while the guard keeps
        // direct hook callers and older Vite versions on the same cheap path.
        if (!mayContainSourceIdentityToken(code)) return null;

        const cleanId = stripViteModuleQuery(id);
        const isServer = this.environment?.config?.consumer !== "client";
        if (isServer) {
          const dependency = dependencyModule(cleanId);
          if (dependency) {
            const importMetaUrlReplacement = mayContainImportMetaUrl(code)
              ? this.environment.mode === "dev"
                ? JSON.stringify(pathToFileURL(dependency.canonicalId).href)
                : emittedModuleIdentity.importMetaUrlInitializer
              : undefined;
            const cjsGlobalInitializers =
              dependency.isCommonJs && mayContainServerCjsGlobal(code)
                ? this.environment.mode === "dev"
                  ? sourcePathCjsGlobalInitializers(dependency.canonicalId)
                  : emittedModuleIdentity.cjsGlobalInitializers
                : undefined;
            if (importMetaUrlReplacement !== undefined || cjsGlobalInitializers) {
              return rewriteModuleIdentity(code, {
                id: dependency.canonicalId,
                importMetaUrlReplacement,
                cjsGlobalInitializers,
              });
            }
          }
        }
        if (isNodeModulesId(cleanId)) return null;

        const paths = getRootPaths();
        if (!paths) return null;
        const canonicalId = transformableModuleCanonicalId(cleanId, paths);
        if (!canonicalId) return null;

        const environment: ImportMetaUrlEnvironment =
          this.environment?.name === "client" ? "client" : "server";
        const explicitCommonJs = [".cjs", ".cts"].includes(path.extname(canonicalId));
        const transformKind: ModuleIdentityTransformKind =
          environment === "client"
            ? "client"
            : explicitCommonJs
              ? this.environment.mode === "dev"
                ? "server-cjs-dev"
                : "server-cjs-build"
              : this.environment.mode === "dev"
                ? "server-dev"
                : "server-build";
        let entry = transformCache.get(id);
        if (
          !entry ||
          entry.source !== code ||
          entry.canonicalRoot !== paths.canonicalRoot ||
          entry.canonicalId !== canonicalId
        ) {
          entry = {
            source: code,
            canonicalRoot: paths.canonicalRoot,
            canonicalId,
            results: new Map(),
          };
          setBoundedCacheEntry(transformCache, id, entry, MAX_TRANSFORM_CACHE_ENTRIES);
        }

        const cached = entry.results.get(transformKind);
        if (cached) return cached.value;

        const value = rewriteCanonicalSourceIdentity(
          code,
          canonicalId,
          paths,
          environment,
          this.environment.mode === "build" && mayContainServerCjsGlobal(code)
            ? emittedModuleIdentity.cjsGlobalInitializers
            : sourcePathCjsGlobalInitializers(canonicalId),
        );
        entry.results.set(transformKind, { value });
        return value;
      },
    },
    renderChunk: {
      order: "post",
      handler(code, chunk, outputOptions) {
        if (this.environment?.config.consumer !== "server" || outputOptions.format !== "es") {
          return null;
        }
        const emittedFileName = resolveEmittedModuleFileName(
          this.environment?.name,
          chunk.fileName,
        );
        return finalizeEmittedModuleIdentity(
          code,
          emittedModuleIdentity.replacements,
          emittedFileName,
        );
      },
    },
  };

  // optimizeDeps is a separate raw Rolldown pipeline: it does not run Vite's
  // app-level hooks and has no reliable Vite Environment on the hook context.
  // Keep this as a stateless adapter over the same parser/analyzer/inserter.
  const optimizeDepsPlugin: Plugin = {
    name: "vinext:import-meta-url:optimize-deps",
    transform: {
      filter: {
        id: /\.(?:[cm]?[jt]s|[jt]sx)(?:\?.*)?$/,
        code: SOURCE_IDENTITY_FILTER_RE,
      },
      handler(code, id) {
        if (!mayContainSourceIdentityToken(code)) return null;
        const dependency = dependencyModule(id);
        if (!dependency) return null;
        return rewriteModuleIdentity(code, {
          id: dependency.canonicalId,
          importMetaUrlReplacement: mayContainImportMetaUrl(code)
            ? emittedModuleIdentity.importMetaUrlInitializer
            : undefined,
          cjsGlobalInitializers:
            dependency.isCommonJs && mayContainServerCjsGlobal(code)
              ? emittedModuleIdentity.cjsGlobalInitializers
              : undefined,
        });
      },
    },
    renderChunk: {
      order: "post",
      handler(code, chunk, outputOptions) {
        if (outputOptions.format !== "es") return null;
        return finalizeEmittedModuleIdentity(
          code,
          emittedModuleIdentity.replacements,
          chunk.fileName,
        );
      },
    },
  };

  return {
    vitePlugin,
    optimizeDepsPlugin,
    isBundledCommonJsDependencyId: (id) => commonJsDependencyCanonicalId(id) !== null,
  };
}

// Test-only entry point. Delegates to the same transform the plugin runs so
// tests exercise the production code path rather than a parallel implementation.
export function rewriteImportMetaUrl(
  code: string,
  id: string,
  root: string,
  environment: ImportMetaUrlEnvironment,
): MagicStringTransformResult | null {
  if (!mayContainImportMetaUrl(code)) return null;
  return rewriteCanonicalSourceIdentity(
    code,
    canonicalizeFilePath(id),
    createRootPaths(root),
    environment,
  );
}

// Test-only entry point. Mirrors the plugin's server eligibility checks and
// then delegates to the same transform the plugin runs, so tests exercise the
// production code path rather than a parallel implementation.
export function rewriteServerCjsGlobals(
  code: string,
  id: string,
  root: string,
): MagicStringTransformResult | null {
  if (!mayContainServerCjsGlobal(code)) return null;
  const rootPaths = createRootPaths(root);
  // Use the same eligibility gate the plugin runs (node_modules, extension,
  // within-root, build-output exclusion) instead of a hand-rolled subset, so
  // the tests exercise the production boundary rather than a parallel one.
  const canonicalId = transformableModuleCanonicalId(id, rootPaths);
  if (!canonicalId) return null;
  return rewriteCanonicalSourceIdentity(code, canonicalId, rootPaths, "server");
}

function rewriteCanonicalSourceIdentity(
  code: string,
  canonicalId: string,
  rootPaths: RootPaths,
  environment: ImportMetaUrlEnvironment,
  cjsGlobalInitializers?: CjsGlobalInitializers,
): MagicStringTransformResult | null {
  return rewriteModuleIdentity(code, {
    id: canonicalId,
    importMetaUrlReplacement: mayContainImportMetaUrl(code)
      ? JSON.stringify(importMetaUrlValue(canonicalId, rootPaths, environment))
      : undefined,
    cjsGlobalInitializers:
      environment === "server" && mayContainServerCjsGlobal(code)
        ? (cjsGlobalInitializers ?? sourcePathCjsGlobalInitializers(canonicalId))
        : undefined,
  });
}

type CjsGlobalInitializers = Record<CjsGlobalName, string>;

type EmittedModuleIdentityField = CjsGlobalName | "url";

function createEmittedModuleIdentity(): {
  cjsGlobalInitializers: CjsGlobalInitializers;
  importMetaUrlInitializer: string;
  replacements: ReadonlyMap<string, EmittedModuleIdentityField>;
} {
  const nonce = randomUUID().replaceAll("-", "");
  const filenameMarker = `__VINEXT_EMITTED_MODULE_FILENAME_${nonce}__`;
  const dirnameMarker = `__VINEXT_EMITTED_MODULE_DIRNAME_${nonce}__`;
  const urlMarker = `__VINEXT_EMITTED_MODULE_URL_${nonce}__`;
  const filenameSentinel = JSON.stringify(filenameMarker);
  const dirnameSentinel = JSON.stringify(dirnameMarker);
  const urlSentinel = JSON.stringify(urlMarker);
  return {
    cjsGlobalInitializers: {
      __filename: emittedModuleIdentityInitializer(filenameSentinel),
      __dirname: emittedModuleIdentityInitializer(dirnameSentinel),
    },
    importMetaUrlInitializer: emittedModuleIdentityInitializer(urlSentinel),
    replacements: new Map([
      [filenameSentinel, "__filename"],
      [dirnameSentinel, "__dirname"],
      [urlSentinel, "url"],
    ]),
  };
}

function emittedModuleIdentityInitializer(sentinel: string): string {
  return `({ get value() { return ${sentinel}; } }).value`;
}

function finalizeEmittedModuleIdentity(
  code: string,
  emittedIdentitySentinels: ReadonlyMap<string, EmittedModuleIdentityField>,
  fileName: string,
): MagicStringTransformResult | null {
  if (!code.includes("__VINEXT_EMITTED_MODULE_")) return null;
  const runtimeBindings = new Set(
    code.match(/\b__vinext_module_(?:process|fs|url|identity)_*\b/g) ?? [],
  );
  function selectRuntimeBinding(base: string): string {
    let binding = base;
    while (runtimeBindings.has(binding)) binding += "_";
    return binding;
  }
  const processNamespaceBinding = selectRuntimeBinding("__vinext_module_process");
  const fsNamespaceBinding = selectRuntimeBinding("__vinext_module_fs");
  const urlNamespaceBinding = selectRuntimeBinding("__vinext_module_url");
  const identityBinding = selectRuntimeBinding("__vinext_module_identity");
  const emittedFileName = toSlash(fileName).replace(/^\.\//, "").replace(/^\/+/, "");
  const processCwd = `(typeof ${processNamespaceBinding}.cwd === "function" ? ${processNamespaceBinding}.cwd() : "")`;
  const emittedPathFallback = emittedFileName
    ? `(${processCwd}.replace(/[\\\\/]$/, "") + ${JSON.stringify(`/${emittedFileName}`)})`
    : `(${processCwd} || "/")`;
  const emittedDirName = path.dirname(emittedFileName);
  const emittedDirFallback =
    emittedDirName === "."
      ? `(${processCwd} || "/")`
      : `(${processCwd}.replace(/[\\\\/]$/, "") + ${JSON.stringify(`/${emittedDirName}`)})`;
  const absoluteEmittedPath = JSON.stringify(`/${emittedFileName}`.replace(/\/$/, "") || "/");
  const replacements: Record<EmittedModuleIdentityField, string> = {
    __filename: `${identityBinding}.filename`,
    __dirname: `${identityBinding}.dirname`,
    url: `${identityBinding}.url`,
  };
  const output = new MagicString(code);
  let changed = false;
  const usedFields = new Set<EmittedModuleIdentityField>();
  for (const [sentinel, field] of emittedIdentitySentinels) {
    let start = code.indexOf(sentinel);
    while (start !== -1) {
      output.overwrite(start, start + sentinel.length, replacements[field]);
      changed = true;
      usedFields.add(field);
      start = code.indexOf(sentinel, start + sentinel.length);
    }
  }
  if (!changed) return null;
  const needsUrl = usedFields.has("url");
  const needsPath = usedFields.has("__filename") || usedFields.has("__dirname");
  const runtimePreamble = [
    ...(needsPath ? [`import * as ${processNamespaceBinding} from "node:process";`] : []),
    ...(needsPath ? [`import * as ${fsNamespaceBinding} from "node:fs";`] : []),
    ...(needsUrl ? [`import * as ${urlNamespaceBinding} from "node:url";`] : []),
    `const ${identityBinding} = (() => {`,
    ...(needsPath
      ? [
          `  const filename = import.meta.filename;`,
          `  const native = typeof filename === "string" && ${fsNamespaceBinding}.existsSync(filename);`,
          `  const resolvedFilename = native ? filename : ${emittedPathFallback};`,
        ]
      : [
          `  const runtimeUrl = import.meta.url;`,
          `  const runtimeFilename = import.meta.filename;`,
        ]),
    `  return {`,
    ...(needsPath
      ? [
          `    filename: resolvedFilename,`,
          `    dirname: native ? import.meta.dirname : ${emittedDirFallback},`,
        ]
      : []),
    ...(needsUrl
      ? [
          needsPath
            ? `    url: ${urlNamespaceBinding}.pathToFileURL(resolvedFilename).href,`
            : `    url: typeof runtimeUrl === "string" && runtimeUrl.startsWith("file:") ? runtimeUrl : ${urlNamespaceBinding}.pathToFileURL(typeof runtimeFilename === "string" ? runtimeFilename : ${absoluteEmittedPath}).href,`,
        ]
      : []),
    `  };`,
    `})();`,
    "",
  ].join("\n");
  if (code.startsWith("#!")) {
    output.appendLeft(code.indexOf("\n") + 1, runtimePreamble);
  } else {
    output.prepend(runtimePreamble);
  }
  return magicStringTransformResult(output);
}

function rewriteModuleIdentity(
  code: string,
  options: {
    id: string;
    importMetaUrlReplacement?: string;
    cjsGlobalInitializers?: CjsGlobalInitializers;
  },
): MagicStringTransformResult | null {
  let ast: unknown;
  try {
    ast = parseAst(code, {
      lang: scriptParserLanguage(options.id) ?? "jsx",
      sourceType: options.cjsGlobalInitializers ? "commonjs" : undefined,
    });
  } catch {
    if (!options.cjsGlobalInitializers) return null;
    try {
      // Project modules can intentionally use Node globals alongside ESM-only
      // syntax such as top-level await. Raw dependencies can instead contain
      // CommonJS-only syntax such as a top-level return, so accept either
      // grammar without weakening the binding analysis.
      ast = parseAst(code, { lang: scriptParserLanguage(options.id) ?? "jsx" });
    } catch {
      return null;
    }
  }

  const output = new MagicString(code);
  let changed = false;

  if (options.importMetaUrlReplacement !== undefined) {
    const importMetaRanges = collectImportMetaUrlRanges(ast);
    if (importMetaRanges.length > 0) {
      for (const range of importMetaRanges) {
        output.overwrite(range.start, range.end, options.importMetaUrlReplacement);
        changed = true;
      }
    }
  }

  if (options.cjsGlobalInitializers) {
    const injected = injectServerCjsGlobals(ast, options.cjsGlobalInitializers);
    if (injected) {
      output.appendLeft(findDirectivePrologueEnd(ast), `\n${injected}`);
      changed = true;
    }
  }

  if (!changed) return null;
  return magicStringTransformResult(output);
}

function isNodeModulesId(id: string): boolean {
  return id.includes("/node_modules/") || id.includes("\\node_modules\\");
}

function setBoundedCacheEntry<K, V>(cache: Map<K, V>, key: K, value: V, limit: number): void {
  if (!cache.has(key) && cache.size >= limit) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.set(key, value);
}

function canonicalDependencyModuleId(
  id: string,
  rootPaths: RootPaths | undefined,
): { canonicalId: string; allowUnpackaged: boolean } | null {
  const cleanId = stripViteModuleQuery(id);
  if (!cleanId || cleanId.startsWith(VIRTUAL_PREFIX)) return null;

  let filePath: string;
  try {
    filePath = cleanId.startsWith("file:") ? toSlash(fileURLToPath(cleanId)) : toSlash(cleanId);
  } catch {
    return null;
  }

  if (!path.isAbsolute(filePath)) return null;
  if (scriptParserLanguage(filePath) === null) return null;
  const canonicalId = canonicalizeFilePath(filePath);
  if (isNodeModulesId(filePath)) return { canonicalId, allowUnpackaged: true };
  if (!rootPaths || isPathInsideOrEqual(rootPaths.canonicalRoot, canonicalId)) return null;
  return { canonicalId, allowUnpackaged: false };
}

function isCommonJsDependency(canonicalId: string, allowUnpackaged: boolean): boolean {
  const extension = path.extname(canonicalId);
  if (extension === ".cjs" || extension === ".cts") return true;
  if (extension === ".mjs" || extension === ".mts") return false;

  // For ambiguous .js/.jsx/.ts/.tsx files, Node's nearest package scope is
  // the authoritative module-format metadata. Default to CommonJS exactly as
  // Node does when the package omits `type` or has no package.json.
  let directory = path.dirname(canonicalId);
  for (;;) {
    const packageJsonPath = path.join(directory, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
          type?: unknown;
        };
        return packageJson.type !== "module";
      } catch {
        return true;
      }
    }

    // Node package scopes never cross a node_modules boundary. An unpackaged
    // dependency therefore keeps Node's default CommonJS format even when the
    // application above node_modules is declared as type: module.
    if (path.basename(directory) === "node_modules") return allowUnpackaged;

    const parent = path.dirname(directory);
    if (parent === directory) return allowUnpackaged;
    directory = parent;
  }
}

function createRootPaths(root: string, options: { outputDirs?: string[] } = {}): RootPaths {
  const canonicalRoot = canonicalizeFilePath(root);
  return {
    root,
    canonicalRoot,
    excludedRelativePrefixes: excludedRelativePrefixes(canonicalRoot, options),
  };
}

// Returns the canonical module id when the module is eligible for rewriting,
// or null otherwise. Threading the canonical id back to the caller avoids a
// second realpathSync when computing the replacement value.
function transformableModuleCanonicalId(id: string, rootPaths: RootPaths): string | null {
  if (!id || id.startsWith(VIRTUAL_PREFIX)) return null;
  if (!path.isAbsolute(id)) return null;
  // Bundler-provided ids can arrive with native separators on Windows.
  const slashedInputId = toSlash(id);
  // Early-exit optimization: skip the realpathSync below for node_modules
  // paths, which are the majority of modules in a typical project. The
  // isPathInsideOrEqual check below provides a second safety net in case a
  // symlink causes the canonical path to land outside node_modules.
  if (slashedInputId.includes("/node_modules/")) return null;
  if (scriptParserLanguage(slashedInputId) === null) return null;

  const canonicalId = canonicalizeFilePath(id);
  if (!isPathInsideOrEqual(rootPaths.canonicalRoot, canonicalId)) return null;

  const relativePath = path.relative(rootPaths.canonicalRoot, canonicalId);
  if (isExcludedRelativePath(relativePath, rootPaths.excludedRelativePrefixes)) return null;
  return canonicalId;
}

function mayContainImportMetaUrl(code: string): boolean {
  return IMPORT_META_URL_CANDIDATE_RE.test(code);
}

function mayContainSourceIdentityToken(code: string): boolean {
  return mayContainImportMetaUrl(code) || mayContainServerCjsGlobal(code);
}

function mayContainServerCjsGlobal(code: string): boolean {
  return code.includes("__filename") || code.includes("__dirname");
}

function excludedRelativePrefixes(
  canonicalRoot: string,
  options: { outputDirs?: string[] },
): string[] {
  // Static list of known output/build directories whose modules must
  // never have import.meta.url rewritten (they are build artifacts, not
  // user source). Custom output directories are added dynamically from
  // config.build.outDir in configResolved. Using .gitignore was considered
  // but adds unnecessary filesystem overhead for this narrow use case.
  const prefixes = new Set([".next", ".vinext", ".vinext-local-package", "dist", "out"]);

  for (const outputDir of options.outputDirs ?? []) {
    const absoluteOutputDir = path.isAbsolute(outputDir)
      ? outputDir
      : path.resolve(canonicalRoot, outputDir);
    const canonicalOutputDir = canonicalizeFilePath(absoluteOutputDir);
    if (!isPathInsideOrEqual(canonicalRoot, canonicalOutputDir)) continue;

    const relativePath = path.relative(canonicalRoot, canonicalOutputDir);
    if (relativePath && relativePath !== ".") prefixes.add(relativePath);
  }

  return [...prefixes];
}

function isExcludedRelativePath(relativePath: string, prefixes: string[]): boolean {
  return prefixes.some(
    (prefix) => relativePath === prefix || relativePath.startsWith(`${prefix}/`),
  );
}

function importMetaUrlValue(
  canonicalId: string,
  rootPaths: RootPaths,
  environment: ImportMetaUrlEnvironment,
): string {
  if (environment === "client") {
    const relativePath = path.relative(rootPaths.canonicalRoot, canonicalId);
    return `file:///ROOT/${relativePath}`;
  }

  return pathToFileURL(canonicalId).href;
}

function collectImportMetaUrlRanges(ast: unknown): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];

  function visit(value: unknown): void {
    if (!isAstRecord(value)) return;

    if (isImportMetaUrlNode(value)) {
      ranges.push({ start: value.start, end: value.end });
      return;
    }

    if (isChainExpressionWrappingImportMetaUrl(value)) {
      ranges.push({ start: value.start, end: value.end });
      return;
    }

    if (isNewUrlExpression(value)) {
      const args = nodeArray(value.arguments);
      for (let index = 0; index < args.length; index += 1) {
        if (index === 1 && isImportMetaUrlBaseNode(args[index])) continue;
        visit(args[index]);
      }
      // The callee is always the bare `URL` identifier (see isNewUrlExpression),
      // so it can never contain an import.meta.url read — no need to visit it.
      return;
    }

    forEachAstChild(value, visit);
  }

  visit(ast);
  return ranges;
}

// Bake __filename/__dirname as top-level `var` literals computed in the plugin
// from the module's canonical path, and let JavaScript scope rules handle
// params, nested locals, object shorthand, assignment behaviour, etc. — simpler
// and more correct than a free-identifier replacement walker that must model
// lexical scope.
//
// The injection rule in one place: inject when the module reads the name and
// nothing in module scope already binds it.
type CjsGlobalName = "__filename" | "__dirname";
const CJS_GLOBALS: readonly CjsGlobalName[] = ["__filename", "__dirname"];

function isCjsGlobalName(name: unknown): name is CjsGlobalName {
  return name === "__filename" || name === "__dirname";
}

function sourcePathCjsGlobalInitializers(canonicalId: string): CjsGlobalInitializers {
  return {
    __filename: JSON.stringify(canonicalId),
    __dirname: JSON.stringify(path.dirname(canonicalId)),
  };
}

function injectServerCjsGlobals(ast: unknown, initializers: CjsGlobalInitializers): string | null {
  const analysis = analyzeServerCjsGlobals(ast);
  const parts = CJS_GLOBALS.filter(
    (name) => analysis.reads.has(name) && !analysis.moduleBindings.has(name),
  ).map((name) => `var ${name} = ${initializers[name]};`);
  return parts.length ? parts.join("") : null;
}

type ServerCjsAnalysis = {
  reads: Set<CjsGlobalName>;
  moduleBindings: Set<CjsGlobalName>;
};

// One pass collects the two module facts we need:
//   - reads: names used as values
//   - moduleBindings: names bound anywhere in module scope, including `var`
//     declarations hidden inside top-level blocks and control flow
function analyzeServerCjsGlobals(ast: unknown): ServerCjsAnalysis {
  const reads = new Set<CjsGlobalName>();
  const moduleBindings = new Set<CjsGlobalName>();

  // Recursively walks a binding pattern. Each name found is a module binding.
  function recordBinding(pattern: unknown): void {
    const names = new Set<string>();
    collectBindingNames(pattern, names);
    for (const name of names) {
      if (isCjsGlobalName(name)) moduleBindings.add(name);
    }
  }

  // Records bindings declared directly by a top-level statement. `var` is
  // handled by the recursive walk below so nested blocks and loops use the
  // same rule.
  function recordDirectTopLevelBindings(statement: AstRecord): void {
    if (statement.declare === true) return;
    const t = statement.type;
    switch (t) {
      case "ImportDeclaration":
        for (const specifier of nodeArray(statement.specifiers)) {
          if (!isAstRecord(specifier)) continue;
          recordBinding(specifier.local);
        }
        return;
      case "VariableDeclaration":
        if (statement.kind === "var") return;
        for (const declarator of nodeArray(statement.declarations)) {
          if (!isAstRecord(declarator) || declarator.type !== "VariableDeclarator") continue;
          recordBinding(declarator.id);
        }
        return;
      case "FunctionDeclaration":
      case "ClassDeclaration":
        recordBinding(statement.id);
        return;
      case "ExportNamedDeclaration":
      case "ExportDefaultDeclaration":
        if (isAstRecord(statement.declaration)) {
          recordDirectTopLevelBindings(statement.declaration);
        }
        return;
    }
  }

  // Walk only syntax whose `var` declarations remain module-scoped. Function
  // and class bodies are scope boundaries.
  function recordModuleScopedVarBindings(node: unknown): void {
    if (!isAstRecord(node)) return;
    const t = node.type;
    switch (t) {
      case "Program":
        for (const statement of nodeArray(node.body)) {
          if (!isAstRecord(statement)) continue;
          recordDirectTopLevelBindings(statement);
          recordModuleScopedVarBindings(statement);
        }
        return;
      case "VariableDeclaration":
        if (node.kind !== "var" || node.declare === true) return;
        for (const declarator of nodeArray(node.declarations)) {
          if (!isAstRecord(declarator) || declarator.type !== "VariableDeclarator") continue;
          recordBinding(declarator.id);
        }
        return;
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
      case "ClassDeclaration":
      case "ClassExpression":
        return;
      default:
        for (const child of moduleScopeChildren(node)) {
          recordModuleScopedVarBindings(child);
        }
    }
  }

  function moduleScopeChildren(node: AstRecord): unknown[] {
    const t = node.type;
    switch (t) {
      case "BlockStatement":
        return nodeArray(node.body);
      case "IfStatement":
        return [node.consequent, node.alternate];
      case "SwitchStatement":
        return nodeArray(node.cases);
      case "SwitchCase":
        return nodeArray(node.consequent);
      case "TryStatement":
        return [node.block, node.handler, node.finalizer];
      case "CatchClause":
        return [node.body];
      case "LabeledStatement":
        return [node.body];
      case "ForStatement":
        return [node.init, node.body];
      case "ForInStatement":
      case "ForOfStatement":
        return [node.left, node.body];
      case "WhileStatement":
      case "DoWhileStatement":
      case "WithStatement":
        return [node.body];
      case "ExportNamedDeclaration":
      case "ExportDefaultDeclaration":
        return [node.declaration];
      default:
        return [];
    }
  }

  // Reads are collected from the whole module.
  //
  // The read walker is intentionally broader than the binding walk: it can
  // over-report names that are already bound locally, and the module binding
  // set decides whether injection is safe.
  function recordReads(value: unknown): void {
    if (!isAstRecord(value)) return;
    const t = value.type;
    switch (t) {
      case "Identifier":
        if (isCjsGlobalName(value.name)) reads.add(value.name);
        return;
      case "MemberExpression":
        recordReads(value.object);
        if (value.computed) recordReads(value.property);
        return;
      case "Property":
        if (value.computed) recordReads(value.key);
        recordReads(value.value);
        return;
      case "MethodDefinition":
      case "PropertyDefinition":
        if (value.computed) recordReads(value.key);
        recordReads(value.value);
        return;
      case "ImportDeclaration":
        // Specifiers bind locals; the imported names and module source string
        // are never value reads. (e.g. `import { __filename as foo }` does not
        // read __filename.)
        return;
      case "ExportAllDeclaration":
        // `export * [as name] from "..."` reads no local value; `name` is only
        // an export name, not a reference to a local binding.
        return;
      case "ExportNamedDeclaration":
        // `export const/function/class ...` — recurse into the declaration.
        // `export { local as exported }` — only `local` references a binding,
        // and only when there is no `source` (a re-export points at the source
        // module, not a local). `exported` is always just a name.
        if (isAstRecord(value.declaration)) {
          recordReads(value.declaration);
        } else if (!value.source) {
          for (const specifier of nodeArray(value.specifiers)) {
            if (isAstRecord(specifier)) recordReads(specifier.local);
          }
        }
        return;
      default:
        forEachAstChild(value, recordReads);
    }
  }

  if (isAstRecord(ast) && ast.type === "Program") {
    recordModuleScopedVarBindings(ast);
  }
  recordReads(ast);

  return { reads, moduleBindings };
}

function isImportMetaNode(value: unknown): boolean {
  return (
    isAstRecord(value) &&
    value.type === "MetaProperty" &&
    isIdentifierNamed(value.meta, "import") &&
    isIdentifierNamed(value.property, "meta")
  );
}

function isImportMetaUrlNode(value: unknown): value is AstRange {
  return (
    isAstRecord(value) &&
    value.type === "MemberExpression" &&
    hasRange(value) &&
    isImportMetaNode(value.object) &&
    isIdentifierNamed(value.property, "url")
  );
}

// Accepts both import.meta.url (MemberExpression) and import.meta?.url
// (ChainExpression wrapping a MemberExpression) so that the new URL() skip
// correctly handles optional-chained base arguments.
function isImportMetaUrlOrChainedNode(value: unknown): value is AstRange {
  if (isImportMetaUrlNode(value)) return true;
  return (
    isAstRecord(value) && value.type === "ChainExpression" && isImportMetaUrlNode(value.expression)
  );
}

function isImportMetaUrlBaseNode(value: unknown): boolean {
  if (isImportMetaUrlOrChainedNode(value)) return true;

  // Vite rewrites worker constructors to:
  //   new URL(emittedWorkerUrl, "" + import.meta.url)
  // Preserve that generated base just like the direct asset-expression form.
  // Replacing it with our source-identity file URL would make the browser
  // resolve the emitted worker against file:// instead of the deployment origin.
  return (
    isAstRecord(value) &&
    value.type === "BinaryExpression" &&
    value.operator === "+" &&
    isAstRecord(value.left) &&
    value.left.type === "Literal" &&
    value.left.value === "" &&
    isImportMetaUrlOrChainedNode(value.right)
  );
}

// Catches the ChainExpression wrapper so we record the outer node range
// and avoid descending into the inner MemberExpression (which happens
// to share the same start/end, but this is more explicit).
function isChainExpressionWrappingImportMetaUrl(value: unknown): value is AstRange {
  return (
    isAstRecord(value) &&
    value.type === "ChainExpression" &&
    hasRange(value) &&
    isImportMetaUrlNode(value.expression)
  );
}

// Only matches bare `new URL(...)`, not `new globalThis.URL(...)` or
// `new window.URL(...)`. Matches Vite's own asset-detection scope.
function isNewUrlExpression(value: AstRecord): boolean {
  return value.type === "NewExpression" && isIdentifierNamed(value.callee, "URL");
}

function findDirectivePrologueEnd(ast: unknown): number {
  if (!isAstRecord(ast) || ast.type !== "Program") return 0;

  // A shebang (`#!...`) lives outside ast.body but must stay the first bytes of
  // the file, so the injection floor starts after it. Inserting at offset 0
  // would move the shebang off line 1 and produce invalid output.
  let end = 0;
  const hashbang = ast.hashbang;
  const hashbangEnd =
    typeof hashbang === "object" && hashbang !== null ? Reflect.get(hashbang, "end") : null;
  if (typeof hashbangEnd === "number") {
    end = hashbangEnd;
  }

  for (const statement of nodeArray(ast.body)) {
    if (
      !isAstRecord(statement) ||
      statement.type !== "ExpressionStatement" ||
      !isAstRecord(statement.expression) ||
      statement.expression.type !== "Literal" ||
      typeof statement.expression.value !== "string" ||
      typeof statement.end !== "number"
    ) {
      break;
    }
    end = statement.end;
  }

  return end;
}
