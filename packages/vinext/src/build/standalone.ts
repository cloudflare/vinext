import fs from "node:fs";
// Standalone output assembly works entirely in native-separator space: it
// copies directory trees with fs.cpSync filters that split on path.sep and
// never feeds paths back into id/URL comparisons, so pathslash buys nothing.
// oxlint-disable-next-line no-restricted-imports
import path from "node:path";
import { createRequire, isBuiltin } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseSync, type ESTree, type ParserOptions } from "vite";
import {
  EMPTY_EXPORT_PRESCAN,
  forEachAstChild,
  isIdentifierNamed,
  quotedStringAt,
  staticStringValue,
  unwrapExpression,
} from "../plugins/ast-utils.js";
import { packageNameFromSpecifier } from "../utils/package-name.js";
import { readJsonFile } from "../utils/safe-json-file.js";
import { resolveVinextPackageRoot } from "../utils/vinext-root.js";

type PackageJson = {
  name?: string;
  main?: string;
  exports?: unknown;
  imports?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

type StandaloneBuildOptions = {
  root: string;
  outDir: string;
  /**
   * Test hook: override vinext package root used for embedding runtime files.
   */
  vinextPackageRoot?: string;
};

type StandaloneBuildResult = {
  standaloneDir: string;
  copiedPackages: string[];
};

type QueueEntry = {
  packageName: string;
  resolver: NodeRequire;
  optional: boolean;
};

function readPackageJson(packageJsonPath: string): PackageJson {
  return JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as PackageJson;
}

/** Returns both `dependencies` and `optionalDependencies` keys — the full set of potential runtime deps. */
function runtimeDeps(pkg: PackageJson): string[] {
  return Object.keys({
    ...pkg.dependencies,
    ...pkg.optionalDependencies,
  });
}

/**
 * Read the externals manifest written by the `vinext:server-externals-manifest`
 * Vite plugin during the production build.
 *
 * The manifest (`dist/server/vinext-externals.json`) contains the exact bare
 * specifiers that the bundler left external in the SSR/RSC output — i.e. the
 * package imports the server bundle actually performs at runtime. Using this
 * instead of scanning emitted files with regexes or seeding from
 * `package.json#dependencies` avoids both false negatives (missed imports) and
 * false positives (client-only deps that are never loaded server-side).
 *
 * Falls back to an empty array if the manifest does not exist (e.g. when
 * running against a build that predates this feature).
 */
function readServerExternalsManifest(serverDir: string): string[] {
  const manifestPath = path.join(serverDir, "vinext-externals.json");
  if (!fs.existsSync(manifestPath)) {
    return [];
  }
  return (
    readJsonFile<string[]>(manifestPath, {
      onError: (err) => {
        console.warn(
          `[vinext] Warning: failed to parse ${manifestPath}, proceeding without externals manifest: ${String(err)}`,
        );
      },
    }) ?? []
  );
}

function resolvePackageJsonPath(packageName: string, resolver: NodeRequire): string | null {
  try {
    return resolver.resolve(`${packageName}/package.json`);
  } catch {
    // Some packages only expose subpath exports (for example `rsc-html-stream`,
    // which exports `./server` but not `.` or `./package.json`). resolver.resolve()
    // cannot access those hidden paths, but Node still exposes the installed
    // node_modules lookup locations via resolve.paths().
    const lookupPaths = resolver.resolve.paths(packageName) ?? [];
    for (const lookupPath of lookupPaths) {
      const candidate = path.join(lookupPath, packageName, "package.json");
      if (fs.existsSync(candidate)) {
        const pkg = readPackageJson(candidate);
        if (pkg.name === packageName) {
          return candidate;
        }
      }
    }

    // Some packages do not export ./package.json via exports map.
    // Fallback: resolve package entry and walk up to the nearest matching package.json.
    try {
      const entryPath = resolver.resolve(packageName);
      let dir = path.dirname(entryPath);
      while (dir !== path.dirname(dir)) {
        const candidate = path.join(dir, "package.json");
        if (fs.existsSync(candidate)) {
          const pkg = readPackageJson(candidate);
          if (pkg.name === packageName) {
            return candidate;
          }
        }
        dir = path.dirname(dir);
      }
    } catch {
      // fallthrough to null
    }
    return null;
  }
}

// ── Runtime import tracing ──────────────────────────────────────────────────
//
// Copying `dependencies` alone misses packages that runtime code imports
// without declaring them as dependencies — most often peer dependencies, such
// as `@emotion/react` imported by `@mui/material`, or `react` imported by
// vinext's own production server. Next.js finds these by tracing the files its
// server loads (@vercel/nft). This tracer follows the same idea without the
// dependency: starting from the files the server bundle and the prod server
// load, it parses each reachable file, follows its literal `import`,
// `export ... from`, `import()`, `require()` and `require.resolve()`
// specifiers, and reports every installed package it reaches.

type ImportKind = "import" | "require";

// Node's default conditions vary by runtime: `module-sync` is on by default
// only from Node 22.12 (vinext supports >= 22), and `--no-addons` turns off
// `node-addons`. Trace every branch a supported runtime can select.
function runtimeConditionSets(kind: ImportKind): string[][] {
  const sets: string[][] = [];
  for (const moduleSync of [["module-sync"], []]) {
    for (const addons of [["node-addons"], []]) {
      sets.push(["node", kind, ...moduleSync, ...addons, "default"]);
    }
  }
  return sets;
}
const CONDITION_SETS: Record<ImportKind, string[][]> = {
  import: runtimeConditionSets("import"),
  require: runtimeConditionSets("require"),
};
// Node's implicit LOAD_AS_FILE and directory-index extensions. `.cjs` and
// `.mjs` load only when named explicitly.
const FILE_EXTENSIONS = [".js", ".json", ".node"];
// Node's CommonJS loader runs any other file as JavaScript, and nft parses
// every file but these.
const UNTRACED_FILE_RE = /\.(?:json|node)$/;
// Gates the AST walk for require calls. Deserializing the AST costs far more
// than the parse, and large data modules (such as Shiki's grammars) often
// mention "require" as a keyword without calling it. Over-matching only costs
// a walk. Whitespace before the `(` is allowed; a comment there would hide the
// call, but published code does not write one.
const REQUIRE_PRESCAN_RE = /\brequire\s*(?:\(|\??\.\s*(?:\(|resolve\b))|\bcreateRequire\b/;

type TracedImport = { specifier: string; kind: ImportKind };

function isFile(filePath: string): boolean {
  return fs.statSync(filePath, { throwIfNoEntry: false })?.isFile() ?? false;
}

function resolveFileWithExtensions(basePath: string): string | null {
  if (isFile(basePath)) return basePath;
  for (const extension of FILE_EXTENSIONS) {
    if (isFile(basePath + extension)) return basePath + extension;
  }
  return null;
}

function resolveDirectoryIndex(dir: string): string | null {
  for (const extension of FILE_EXTENSIONS) {
    const indexFile = path.join(dir, `index${extension}`);
    if (isFile(indexFile)) return indexFile;
  }
  return null;
}

/** CommonJS file lookup, following Node's LOAD_AS_FILE then LOAD_AS_DIRECTORY. */
function resolveFileCandidate(basePath: string): string | null {
  return resolveFileWithExtensions(basePath) ?? resolveDirectoryCandidate(basePath);
}

/** Node's LOAD_AS_DIRECTORY: the directory's package.json main, then its index. */
function resolveDirectoryCandidate(basePath: string): string | null {
  const packageJsonPath = path.join(basePath, "package.json");
  const main = isFile(packageJsonPath) ? readPackageJson(packageJsonPath).main : undefined;
  if (main) {
    const mainPath = path.join(basePath, main);
    const mainFile = resolveFileWithExtensions(mainPath) ?? resolveDirectoryIndex(mainPath);
    if (mainFile) return mainFile;
  }
  return resolveDirectoryIndex(basePath);
}

/**
 * Node's PACKAGE_TARGET_RESOLVE validity check: exports targets must be
 * package-relative, while imports targets may also name another package.
 */
function isValidPackageTarget(target: string, isImports: boolean): boolean {
  if (target.startsWith("./")) return true;
  if (!isImports || target.startsWith("../") || target.startsWith("/")) return false;
  return !URL.canParse(target);
}

/**
 * Package targets are URLs relative to the package.json, so `./a%20b.js`
 * names `a b.js`. Returns null for a target Node rejects as a file URL.
 */
function packageTargetPath(packageJsonPath: string, target: string): string | null {
  try {
    return fileURLToPath(new URL(target, pathToFileURL(packageJsonPath)));
  } catch {
    return null;
  }
}

/** Resolve an `exports`/`imports` target value against a condition set. */
function resolveConditionalTarget(
  target: unknown,
  conditions: readonly string[],
  patternMatch: string | null,
  isImports: boolean,
): string | null {
  if (typeof target === "string") {
    // Node skips an invalid target to try the next array item.
    if (!isValidPackageTarget(target, isImports)) return null;
    return patternMatch === null ? target : target.replaceAll("*", patternMatch);
  }
  if (Array.isArray(target)) {
    for (const item of target) {
      const resolved = resolveConditionalTarget(item, conditions, patternMatch, isImports);
      if (resolved !== null) return resolved;
    }
    return null;
  }
  if (target !== null && typeof target === "object") {
    for (const [condition, value] of Object.entries(target)) {
      if (!conditions.includes(condition)) continue;
      const resolved = resolveConditionalTarget(value, conditions, patternMatch, isImports);
      if (resolved !== null) return resolved;
    }
  }
  return null;
}

/**
 * Match `key` against an `exports` subpath map or an `imports` map, including
 * single-`*` patterns, following Node's PACKAGE_IMPORTS_EXPORTS_RESOLVE.
 */
function resolveSubpathMap(
  map: Record<string, unknown>,
  key: string,
  conditions: readonly string[],
  isImports: boolean,
): string | null {
  if (Object.hasOwn(map, key) && !key.includes("*")) {
    return resolveConditionalTarget(map[key], conditions, null, isImports);
  }
  let best: { pattern: string; match: string } | null = null;
  for (const pattern of Object.keys(map)) {
    const star = pattern.indexOf("*");
    if (star === -1 || pattern.indexOf("*", star + 1) !== -1) continue;
    const base = pattern.slice(0, star);
    const trailer = pattern.slice(star + 1);
    if (!key.startsWith(base) || key === base) continue;
    if (key.length < pattern.length || !key.endsWith(trailer)) continue;
    // PATTERN_KEY_COMPARE: the longest base wins, then the longest pattern.
    if (
      best &&
      (best.pattern.indexOf("*") > star ||
        (best.pattern.indexOf("*") === star && best.pattern.length >= pattern.length))
    ) {
      continue;
    }
    best = { pattern, match: key.slice(base.length, key.length - trailer.length) };
  }
  return best
    ? resolveConditionalTarget(map[best.pattern], conditions, best.match, isImports)
    : null;
}

function exportsSubpathMap(exports: unknown): Record<string, unknown> {
  if (typeof exports === "string" || Array.isArray(exports)) return { ".": exports };
  if (exports === null || typeof exports !== "object") return {};
  const keys = Object.keys(exports);
  return keys.length > 0 && keys.every((key) => key.startsWith("."))
    ? (exports as Record<string, unknown>)
    : { ".": exports };
}

/** Resolve `subpath` ("." or "./x") inside an installed package to a file. */
function resolvePackageFile(
  packageRoot: string,
  pkg: PackageJson,
  subpath: string,
  conditions: readonly string[],
): string | null {
  if (pkg.exports !== undefined) {
    const target = resolveSubpathMap(exportsSubpathMap(pkg.exports), subpath, conditions, false);
    if (target === null || !target.startsWith("./")) return null;
    const filePath = packageTargetPath(path.join(packageRoot, "package.json"), target);
    return filePath && isFile(filePath) ? filePath : null;
  }
  if (subpath === ".") {
    // Node's LOAD_AS_DIRECTORY: main as a file or directory index (never as a
    // nested package), then the package's own index.
    const mainPath = pkg.main ? path.join(packageRoot, pkg.main) : null;
    const mainFile = mainPath
      ? (resolveFileWithExtensions(mainPath) ?? resolveDirectoryIndex(mainPath))
      : null;
    return mainFile ?? resolveDirectoryIndex(packageRoot);
  }
  return resolveFileCandidate(path.join(packageRoot, subpath));
}

/** Every distinct file `subpath` resolves to under any of `conditionSets`. */
function resolvePackageFiles(
  packageRoot: string,
  pkg: PackageJson,
  subpath: string,
  conditionSets: readonly (readonly string[])[],
): string[] {
  const files = new Set<string>();
  for (const conditions of conditionSets) {
    const file = resolvePackageFile(packageRoot, pkg, subpath, conditions);
    if (file) files.add(file);
  }
  return [...files];
}

function findPackageScope(filePath: string): string | null {
  let dir = path.dirname(filePath);
  while (dir !== path.dirname(dir)) {
    const candidate = path.join(dir, "package.json");
    if (isFile(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return null;
}

function parseTracedFile(filePath: string, code: string) {
  const sourceType: ParserOptions["sourceType"] = filePath.endsWith(".mjs")
    ? "module"
    : filePath.endsWith(".cjs")
      ? "commonjs"
      : "unambiguous";
  const lang = filePath.endsWith(".jsx") ? "jsx" : "js";
  const result = parseSync(filePath, code, { lang, sourceType });
  if (result.errors.length === 0 || sourceType === "commonjs") return result;
  // Scripts that use CommonJS-only syntax such as a top-level `return`.
  const commonJsResult = parseSync(filePath, code, { lang, sourceType: "commonjs" });
  return commonJsResult.errors.length === 0 ? commonJsResult : result;
}

/**
 * The package a bare specifier names. Names starting with a dot are not
 * relative paths to Node, which looks them up in node_modules like any package:
 * Prisma generates its client into `node_modules/.prisma/client` and
 * `@prisma/client` requires `.prisma/client/default`.
 */
function tracedPackageName(specifier: string): string | null {
  const dotScoped = /^(\.[^/]+\/[^/]+)(?:\/|$)/.exec(specifier);
  return dotScoped ? dotScoped[1] : packageNameFromSpecifier(specifier);
}

function collectFileImports(filePath: string): TracedImport[] {
  const code = fs.readFileSync(filePath, "utf-8");
  const result = parseTracedFile(filePath, code);
  const imports: TracedImport[] = [];
  for (const statement of result.module.staticImports) {
    imports.push({ specifier: statement.moduleRequest.value, kind: "import" });
  }
  for (const statement of result.module.staticExports) {
    for (const entry of statement.entries) {
      if (entry.moduleRequest)
        imports.push({ specifier: entry.moduleRequest.value, kind: "import" });
    }
  }
  if (EMPTY_EXPORT_PRESCAN.test(code)) {
    for (const statement of result.program.body) {
      if (statement.type !== "ExportNamedDeclaration" || !statement.source) continue;
      if (statement.specifiers.length > 0 || statement.exportKind === "type") continue;
      imports.push({ specifier: statement.source.value, kind: "import" });
    }
  }
  for (const dynamicImport of result.module.dynamicImports) {
    const specifier = quotedStringAt(code, dynamicImport.moduleRequest);
    if (specifier !== null) imports.push({ specifier, kind: "import" });
  }
  if (REQUIRE_PRESCAN_RE.test(code)) {
    // Iterative: published code can nest expressions thousands of levels deep
    // (long concatenation chains), which overflows a recursive walk.
    // As nft does: require(), require.resolve(), module.require(), and the
    // same calls on a binding of createRequire() or module.createRequire().
    const requireNames = new Set(["require"]);
    const calls: { requireName: string; specifier: string }[] = [];
    const pending: ESTree.Node[] = [result.program];
    while (pending.length > 0) {
      const node = pending.pop();
      if (!node) continue;
      forEachAstChild(node, (child) => pending.push(child));
      if (node.type === "VariableDeclarator" && node.id.type === "Identifier") {
        const init = unwrapExpression(node.init);
        const initCallee = init?.type === "CallExpression" ? unwrapExpression(init.callee) : null;
        if (
          isIdentifierNamed(initCallee, "createRequire") ||
          (initCallee?.type === "MemberExpression" &&
            isIdentifierNamed(initCallee.property, "createRequire"))
        ) {
          requireNames.add(node.id.name);
        }
        continue;
      }
      if (node.type !== "CallExpression") continue;
      const callee = unwrapExpression(node.callee);
      let requireName: string | null = null;
      if (callee?.type === "Identifier") {
        requireName = callee.name;
      } else if (callee?.type === "MemberExpression") {
        if (
          isIdentifierNamed(callee.object, "module") &&
          isIdentifierNamed(callee.property, "require")
        ) {
          requireName = "require";
        } else if (
          callee.object.type === "Identifier" &&
          isIdentifierNamed(callee.property, "resolve")
        ) {
          requireName = callee.object.name;
        }
      }
      if (requireName === null) continue;
      const specifier = staticStringValue(unwrapExpression(node.arguments[0]));
      if (specifier !== null) calls.push({ requireName, specifier });
    }
    for (const { requireName, specifier } of calls) {
      if (requireNames.has(requireName)) imports.push({ specifier, kind: "require" });
    }
  }
  return imports;
}

/**
 * Trace the files reachable from `entries` and return every installed package
 * they import, each paired with a resolver rooted at the importing file so the
 * copy resolves the same installed instance.
 */
function traceRuntimePackages(
  entries: { specifier: string; importer: string; kinds: readonly ImportKind[] }[],
  entryFiles: string[],
): QueueEntry[] {
  const packages: QueueEntry[] = [];
  const reachedPackages = new Set<string>();
  const visitedFiles = new Set<string>();
  const pendingFiles: string[] = [];
  // Node resolves a package name from the importer's directory alone, and
  // large packages import the same few packages from hundreds of files.
  const packageResolutions = new Map<string, string | null>();
  const tracedPackageEntries = new Set<string>();
  const packageJsonCache = new Map<string, PackageJson>();
  const readCachedPackageJson = (packageJsonPath: string): PackageJson => {
    let pkg = packageJsonCache.get(packageJsonPath);
    if (!pkg) {
      pkg = readPackageJson(packageJsonPath);
      packageJsonCache.set(packageJsonPath, pkg);
    }
    return pkg;
  };

  const enqueueFile = (filePath: string | null) => {
    if (!filePath || UNTRACED_FILE_RE.test(filePath)) return;
    const realPath = fs.realpathSync(filePath);
    if (visitedFiles.has(realPath)) return;
    visitedFiles.add(realPath);
    pendingFiles.push(realPath);
  };

  const traceSpecifier = (specifier: string, importer: string, kind: ImportKind) => {
    if (specifier.startsWith("node:") || isBuiltin(specifier)) return;
    const conditionSets = CONDITION_SETS[kind];

    if (specifier.startsWith("file:")) {
      enqueueFile(resolveFileCandidate(fileURLToPath(specifier)));
      return;
    }
    if (/^\.\.?(?:\/|$)/.test(specifier) || path.isAbsolute(specifier)) {
      const target = path.resolve(path.dirname(importer), specifier);
      // A trailing slash, "." or ".." names a directory, never a sibling file.
      const isDirectory = specifier.endsWith("/") || /(?:^|\/)\.\.?$/.test(specifier);
      enqueueFile(isDirectory ? resolveDirectoryCandidate(target) : resolveFileCandidate(target));
      return;
    }
    if (specifier.startsWith("#")) {
      const scopePackageJson = findPackageScope(importer);
      const imports = scopePackageJson
        ? readCachedPackageJson(scopePackageJson).imports
        : undefined;
      if (!scopePackageJson || imports === null || typeof imports !== "object") return;
      const targets = new Set(
        conditionSets.map((conditions) =>
          resolveSubpathMap(imports as Record<string, unknown>, specifier, conditions, true),
        ),
      );
      for (const target of targets) {
        // A target naming another `#` entry is invalid in Node.
        if (target === null || target.startsWith("#")) continue;
        if (target.startsWith("./")) {
          const targetPath = packageTargetPath(scopePackageJson, target);
          if (targetPath) enqueueFile(resolveFileCandidate(targetPath));
        } else {
          // Node resolves a bare target from the package scope, not the importer.
          traceSpecifier(target, scopePackageJson, kind);
        }
      }
      return;
    }

    const packageName = tracedPackageName(specifier);
    if (!packageName) return;
    const resolutionKey = `${path.dirname(importer)}\0${packageName}`;
    let realPackageJsonPath = packageResolutions.get(resolutionKey);
    if (realPackageJsonPath === undefined) {
      // Unresolvable imports are optional at runtime (guarded requires,
      // optional peers that are not installed); nft skips them the same way.
      const packageJsonPath = resolvePackageJsonPath(packageName, createRequire(importer));
      realPackageJsonPath = packageJsonPath ? fs.realpathSync(packageJsonPath) : null;
      packageResolutions.set(resolutionKey, realPackageJsonPath);
    }
    if (!realPackageJsonPath) return;
    const packageRoot = path.dirname(realPackageJsonPath);
    // Keyed by name too: an npm alias shares its target's realpath but must be
    // copied under its own name.
    const packageKey = `${packageName}\0${packageRoot}`;
    if (!reachedPackages.has(packageKey)) {
      reachedPackages.add(packageKey);
      packages.push({ packageName, resolver: createRequire(importer), optional: true });
    }

    const subpath = `.${specifier.slice(packageName.length)}`;
    const entryKey = `${packageRoot}\0${subpath}\0${kind}`;
    if (tracedPackageEntries.has(entryKey)) return;
    tracedPackageEntries.add(entryKey);
    const entryFiles = resolvePackageFiles(
      packageRoot,
      readCachedPackageJson(realPackageJsonPath),
      subpath,
      conditionSets,
    );
    if (entryFiles.length === 0) {
      try {
        entryFiles.push(createRequire(importer).resolve(specifier));
      } catch {
        // Not resolvable as a file; the package itself is still copied.
      }
    }
    for (const entryFile of entryFiles) enqueueFile(entryFile);
  };

  // Tracing only adds packages on top of the dependency walk, so a file or
  // specifier it cannot follow is skipped with a warning rather than failing
  // the build.
  const traceSafely = (specifier: string, importer: string, kind: ImportKind) => {
    try {
      traceSpecifier(specifier, importer, kind);
    } catch (error) {
      console.warn(
        `[vinext] Warning: could not trace "${specifier}" from ${importer} for standalone output: ${String(error)}`,
      );
    }
  };

  // Breadth-first, so a package name is first reached through its nearest importer.
  let index = 0;
  const tracePendingFiles = () => {
    for (; index < pendingFiles.length; index++) {
      const filePath = pendingFiles[index];
      let imports: TracedImport[];
      try {
        imports = collectFileImports(filePath);
      } catch (error) {
        console.warn(
          `[vinext] Warning: could not trace imports of ${filePath} for standalone output: ${String(error)}`,
        );
        continue;
      }
      for (const { specifier, kind } of imports) traceSafely(specifier, filePath, kind);
    }
  };

  // Entry files first: where they and an entry specifier reach different
  // copies of one package name, the flat output keeps the entry files' copy.
  for (const entryFile of entryFiles) enqueueFile(entryFile);
  tracePendingFiles();
  for (const entry of entries) {
    for (const kind of entry.kinds) traceSafely(entry.specifier, entry.importer, kind);
  }
  tracePendingFiles();

  return packages;
}

function copyPackageAndRuntimeDeps(
  targetNodeModulesDir: string,
  queue: QueueEntry[],
  copied: Set<string>,
): void {
  // Package names already in `copied` are skipped: the standalone
  // node_modules/ is flat, so the first resolution of a name wins.
  while (queue.length > 0) {
    const entry = queue.shift();
    if (!entry) continue;
    if (copied.has(entry.packageName)) continue;

    const packageJsonPath = resolvePackageJsonPath(entry.packageName, entry.resolver);
    if (!packageJsonPath) {
      if (entry.optional) {
        continue;
      }
      throw new Error(
        `Failed to resolve required runtime dependency "${entry.packageName}" for standalone output`,
      );
    }

    const realPackageJsonPath = fs.realpathSync(packageJsonPath);
    const packageRoot = path.dirname(realPackageJsonPath);
    const packageTarget = path.join(targetNodeModulesDir, entry.packageName);
    fs.mkdirSync(path.dirname(packageTarget), { recursive: true });
    fs.cpSync(packageRoot, packageTarget, {
      recursive: true,
      dereference: true,
      // Skip any nested node_modules/ inside the package — the BFS walk
      // resolves deps at their correct hoisted location, so nested copies
      // would be stale duplicates. Use path segment splitting so that a
      // directory merely containing "node_modules" as a substring (e.g.
      // "not_node_modules_v2") is not accidentally filtered out.
      filter: (src) => {
        const rel = path.relative(packageRoot, src);
        return !rel.split(path.sep).includes("node_modules");
      },
    });

    copied.add(entry.packageName);

    const packageResolver = createRequire(realPackageJsonPath);
    const pkg = readPackageJson(realPackageJsonPath);
    const optionalDeps = new Set(Object.keys(pkg.optionalDependencies ?? {}));
    for (const depName of runtimeDeps(pkg)) {
      if (!copied.has(depName)) {
        queue.push({
          packageName: depName,
          resolver: packageResolver,
          optional: optionalDeps.has(depName),
        });
      }
    }
  }
}

function writeStandaloneServerEntry(filePath: string): void {
  // Uses import.meta.dirname (Node >= 21.2, vinext requires >= 22) so the
  // entry point is pure ESM — no need for CJS require() or __dirname.
  //
  // The static import of "vinext/server/prod-server" is intentional: that
  // subpath is a documented export in vinext's package.json exports map and
  // is always present in the standalone node_modules/vinext/dist tree
  // (emitStandaloneOutput copies vinext's dist/ directory in full). A static
  // import gives a clearer ERR_MODULE_NOT_FOUND at startup rather than a
  // runtime error deep inside the server if the import were deferred.
  const content = `#!/usr/bin/env node
import { join } from "node:path";
import { startProdServer } from "vinext/server/prod-server";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const host = process.env.HOST ?? "0.0.0.0";

startProdServer({
  port,
  host,
  outDir: join(import.meta.dirname, "dist"),
}).catch((error) => {
  console.error("[vinext] Failed to start standalone server");
  console.error(error);
  process.exit(1);
});
`;
  fs.writeFileSync(filePath, content, "utf-8");
  fs.chmodSync(filePath, 0o755);
}

function writeStandalonePackageJson(filePath: string): void {
  fs.writeFileSync(
    filePath,
    JSON.stringify(
      {
        private: true,
        type: "module",
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  );
}

/**
 * Emit standalone production output for self-hosted deployments.
 *
 * Creates:
 * - <outDir>/standalone/server.js
 * - <outDir>/standalone/dist/{client,server}
 * - <outDir>/standalone/node_modules (runtime deps only)
 *
 * The set of packages copied into node_modules/ is determined by
 * `dist/server/vinext-externals.json`, which is written by the
 * `vinext:server-externals-manifest` Vite plugin during the production build.
 * It contains exactly the specifiers the server bundle imports at runtime
 * (i.e. those left external by the bundler), so no client-only deps are
 * included. Those specifiers and vinext's production server entry are traced
 * through their imports, so packages they load without declaring them as
 * dependencies (such as optional peers) ship too.
 */
export function emitStandaloneOutput(options: StandaloneBuildOptions): StandaloneBuildResult {
  const root = path.resolve(options.root);
  const outDir = path.resolve(options.outDir);
  const clientDir = path.join(outDir, "client");
  const serverDir = path.join(outDir, "server");

  if (!fs.existsSync(clientDir) || !fs.existsSync(serverDir)) {
    throw new Error(`No build output found in ${outDir}. Run vite build first.`);
  }

  const standaloneDir = path.join(outDir, "standalone");
  const standaloneDistDir = path.join(standaloneDir, "dist");
  const standaloneNodeModulesDir = path.join(standaloneDir, "node_modules");

  fs.rmSync(standaloneDir, { recursive: true, force: true });
  fs.mkdirSync(standaloneDistDir, { recursive: true });

  fs.cpSync(clientDir, path.join(standaloneDistDir, "client"), {
    recursive: true,
    dereference: true,
    // Build output shouldn't contain node_modules, but filter defensively for
    // consistency with the other cpSync calls in this function.
    filter: (src) => !path.relative(clientDir, src).split(path.sep).includes("node_modules"),
  });
  fs.cpSync(serverDir, path.join(standaloneDistDir, "server"), {
    recursive: true,
    dereference: true,
    filter: (src) => !path.relative(serverDir, src).split(path.sep).includes("node_modules"),
  });
  const clientAssetsSidecar = path.join(outDir, "vinext-client-assets.js");
  if (fs.existsSync(clientAssetsSidecar)) {
    fs.copyFileSync(clientAssetsSidecar, path.join(standaloneDistDir, "vinext-client-assets.js"));
  }

  const publicDir = path.join(root, "public");
  if (fs.existsSync(publicDir)) {
    fs.cpSync(publicDir, path.join(standaloneDir, "public"), {
      recursive: true,
      dereference: true,
      // Defensive: public/ containing node_modules is extremely unlikely but
      // filter for consistency with the other cpSync calls in this function.
      filter: (src) => !path.relative(publicDir, src).split(path.sep).includes("node_modules"),
    });
  }

  fs.mkdirSync(standaloneNodeModulesDir, { recursive: true });

  // Seed from the manifest written by vinext:server-externals-manifest during
  // the production build. This is the authoritative list of package imports
  // the server bundle performs at runtime — determined by the bundler's own
  // graph, not regex scanning or package.json#dependencies.
  //
  // The manifest is always written to dist/server/vinext-externals.json regardless
  // of whether the build is App Router (rsc + ssr sub-dirs) or Pages Router (ssr
  // only). The plugin walks up from options.dir to find the "server" ancestor, so
  // both dist/server (Pages Router) and dist/server/ssr (App Router SSR) resolve
  // to the same dist/server output path.
  const rootPackageJsonPath = path.join(root, "package.json");
  const rootResolver = createRequire(rootPackageJsonPath);
  const rootOptional = new Set(
    Object.keys(readPackageJson(rootPackageJsonPath).optionalDependencies ?? {}),
  );
  const externalSpecifiers = readServerExternalsManifest(serverDir).filter(
    (specifier) => packageNameFromSpecifier(specifier) !== "vinext",
  );
  const manifestPackages = [
    ...new Set(externalSpecifiers.map((specifier) => packageNameFromSpecifier(specifier))),
  ].filter((name): name is string => name !== null);

  const vinextPackageRoot = resolveVinextPackageRoot(options.vinextPackageRoot);
  const vinextPkg = readPackageJson(path.join(vinextPackageRoot, "package.json"));
  const prodServerFiles = resolvePackageFiles(
    vinextPackageRoot,
    vinextPkg,
    "./server/prod-server",
    CONDITION_SETS.import,
  );

  // Trace what the bundle's externals and vinext's prod server (the entry
  // server.js imports) load at runtime, so packages they import without
  // declaring them as dependencies, such as peer dependencies, are shipped.
  // The prod server is traced first, so the packages it loads take priority
  // over other copies an external reaches. The server bundle may reach an
  // external through either an import or a bundler-emitted require, so trace
  // both conditions.
  const tracedPackages = traceRuntimePackages(
    externalSpecifiers.map((specifier) => ({
      specifier,
      importer: rootPackageJsonPath,
      kinds: ["import", "require"],
    })),
    prodServerFiles,
  ).filter((entry) => entry.packageName !== "vinext");

  // The flat node_modules/ keeps the first copy of each name, so order is the
  // version priority: the manifest's packages, then traced packages (the prod
  // server's before the externals'), then the
  // declared dependencies of both, and vinext's own dependencies last.
  const copiedSet = new Set<string>();
  copyPackageAndRuntimeDeps(
    standaloneNodeModulesDir,
    [
      ...manifestPackages.map((packageName) => ({
        packageName,
        resolver: rootResolver,
        optional: rootOptional.has(packageName),
      })),
      ...tracedPackages,
    ],
    copiedSet,
  );

  // Always embed the exact vinext runtime that produced this build.
  const vinextDistDir = path.join(vinextPackageRoot, "dist");
  if (!fs.existsSync(vinextDistDir)) {
    throw new Error(`vinext runtime dist/ not found at ${vinextPackageRoot}`);
  }
  const vinextTargetDir = path.join(standaloneNodeModulesDir, "vinext");
  fs.mkdirSync(vinextTargetDir, { recursive: true });
  fs.copyFileSync(
    path.join(vinextPackageRoot, "package.json"),
    path.join(vinextTargetDir, "package.json"),
  );
  fs.cpSync(vinextDistDir, path.join(vinextTargetDir, "dist"), {
    recursive: true,
    dereference: true,
    // Defensive: skip any node_modules/ that may exist inside vinext's dist/.
    filter: (src) => {
      const rel = path.relative(vinextDistDir, src);
      return !rel.split(path.sep).includes("node_modules");
    },
  });
  copiedSet.add("vinext");

  // Copy vinext's own runtime dependencies. The prod-server imports packages
  // like `rsc-html-stream` at runtime; they must be present in standalone
  // node_modules/ even if the user's app doesn't depend on them directly.
  // We resolve them from vinext's package root so nested requires work correctly.
  const vinextResolver = createRequire(path.join(vinextPackageRoot, "package.json"));
  const vinextOptional = new Set(Object.keys(vinextPkg.optionalDependencies ?? {}));
  copyPackageAndRuntimeDeps(
    standaloneNodeModulesDir,
    runtimeDeps(vinextPkg).map((packageName) => ({
      packageName,
      resolver: vinextResolver,
      optional: vinextOptional.has(packageName),
    })),
    copiedSet,
  );

  writeStandaloneServerEntry(path.join(standaloneDir, "server.js"));
  writeStandalonePackageJson(path.join(standaloneDir, "package.json"));

  return {
    standaloneDir,
    copiedPackages: [...copiedSet],
  };
}
