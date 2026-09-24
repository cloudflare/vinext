import { readFileSync, realpathSync } from "node:fs";
import { glob, lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path, { toSlash } from "pathslash";
import { pathToFileURL } from "node:url";
import MagicString from "magic-string";
import {
  isRunnableDevEnvironment,
  parseAst,
  searchForWorkspaceRoot,
  type DevEnvironment,
  type Environment,
  type Plugin,
  type ViteDevServer,
} from "vite";
import { NODE_MODULES_PATH_RE, stripViteModuleQuery } from "../utils/path.js";
import { SCRIPT_MODULE_ID_RE, walkAst } from "./ast-utils.js";

type NextSwcModule = {
  loadBindings(): Promise<unknown>;
  transform(
    source: string,
    options: Record<string, unknown>,
  ): Promise<{ code: string; map?: string }>;
};

type StyledJsxPluginOptions = {
  importModule?: (url: string) => Promise<NextSwcModule>;
};

/**
 * Server-only module that hands styled-jsx's own `StyleRegistry` and
 * `createStyleRegistry` to `vinext/shims/styled-jsx-registry`, so Pages Router
 * SSR can render `<style jsx>` rules into the document the way Next.js's
 * `render.tsx` does. Loaded through `RESOLVED_STYLED_JSX_STYLE_ID`, which keeps
 * styled-jsx out of server bundles for apps that never use it.
 */
export const STYLED_JSX_SSR_REGISTRY_ID = "virtual:vinext-styled-jsx-ssr-registry";
const RESOLVED_STYLED_JSX_SSR_REGISTRY_ID = "\0" + STYLED_JSX_SSR_REGISTRY_ID;
/**
 * What server environments load for `styled-jsx/style` — the `JSXStyle`
 * component every compiled `<style jsx>` renders, whether this plugin compiled
 * it or a dependency ships it precompiled — so any module using styled-jsx
 * registers it. `import`s get an ES module; `require()` calls (CommonJS
 * dependencies, in builds) get a CommonJS module with the same `module.exports`
 * as `styled-jsx/style`, whether its caller unwraps `.default` or not.
 */
const RESOLVED_STYLED_JSX_STYLE_ID = "\0vinext-styled-jsx-style";
const STYLED_JSX_STYLE_CODE = `import ${JSON.stringify(STYLED_JSX_SSR_REGISTRY_ID)};
export { default } from "styled-jsx/style";
`;
const RESOLVED_STYLED_JSX_STYLE_CJS_ID = "\0vinext-styled-jsx-style-cjs";
const STYLED_JSX_STYLE_CJS_CODE = `require(${JSON.stringify(STYLED_JSX_SSR_REGISTRY_ID)});
module.exports = require("styled-jsx/style");
`;
/**
 * Dev only: imported by the generated Pages entries (Cloudflare and hybrid
 * dev). Imports `STYLED_JSX_SSR_REGISTRY_ID` when the project uses styled-jsx
 * and is empty otherwise; reloaded if the project starts using it.
 */
export const STYLED_JSX_DEV_REGISTRATION_ID = "virtual:vinext-styled-jsx-dev-registration";
const RESOLVED_STYLED_JSX_DEV_REGISTRATION_ID = "\0" + STYLED_JSX_DEV_REGISTRATION_ID;
const STYLED_JSX_RESOLVE_ID_RE =
  /^(?:styled-jsx(?:\/.*)?|virtual:vinext-styled-jsx-(?:ssr-registry|dev-registration))$/;
// `styled-jsx/style` is what compiled modules import. Loading it with the
// registry lets a dev dependency optimizer discover both at once, instead of
// re-optimizing (and swapping React copies) mid-render when a lazily loaded
// module first imports it after the registration was loaded up front.
const STYLED_JSX_SSR_REGISTRY_CODE = `import * as styledJsx from "styled-jsx";
import "styled-jsx/style";
import { registerStyledJsxRuntime } from "vinext/shims/styled-jsx-registry";
const runtime = typeof styledJsx.StyleRegistry === "function" ? styledJsx : styledJsx.default;
registerStyledJsxRuntime({
  StyleRegistry: runtime.StyleRegistry,
  createStyleRegistry: runtime.createStyleRegistry,
});
`;
const STYLED_JSX_REGISTRY_SHIM = "vinext/shims/styled-jsx-registry";
/** Prefix for dev-only ESM facades over natively required styled-jsx files. */
const STYLED_JSX_NODE_MODULE_PREFIX = "\0vinext-styled-jsx-node:";
const STYLED_JSX_LOAD_RE =
  /^\0(?:virtual:vinext-styled-jsx-(?:ssr-registry|dev-registration)$|vinext-styled-jsx-(?:style(?:-cjs)?$|node:))/;
const JS_IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;
const STYLED_JSX_SOURCE_RE =
  /(?:<style\b|from\s+["']styled-jsx\/css["']|require\s*\(\s*["']styled-jsx\/css["']\s*\))/;
const STYLED_JSX_CSS_RE =
  /(?:from\s+["']styled-jsx\/css["']|require\s*\(\s*["']styled-jsx\/css["']\s*\))/;
const SOURCE_SCAN_GLOB = "**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}";
const SOURCE_SCAN_BATCH_SIZE = 64;

const SOURCE_SCAN_FILE_RE = /\.(?:jsx?|tsx?|[cm][jt]s)$/;

/** Skip dependencies, dot directories (VCS, caches) and vinext's build output. */
function isExcludedFromSourceScan(entry: string): boolean {
  const name = entry.slice(Math.max(entry.lastIndexOf("/"), entry.lastIndexOf("\\")) + 1);
  return name === "node_modules" || name === "dist" || name.startsWith(".");
}

/** Whether the source scan of `roots` covers `file` (an absolute path). */
function isScannedSourceFile(roots: readonly string[], file: string): boolean {
  return SOURCE_SCAN_FILE_RE.test(file) && isInsideSourceRoots(roots, file);
}

/**
 * Whether `file` lies under one of `roots`, outside the directories the scan
 * skips. File watchers can report real paths for a root reached through a
 * symlink, so each root's real path counts too.
 */
function isInsideSourceRoots(roots: readonly string[], file: string): boolean {
  return roots.some((root) => {
    let realRoot = root;
    try {
      realRoot = toSlash(realpathSync.native(root));
    } catch {}
    return [root, realRoot].some((candidate) => {
      const relative = path.relative(candidate, file);
      if (relative.startsWith("../") || path.isAbsolute(relative)) return false;
      return !relative.split("/").some(isExcludedFromSourceScan);
    });
  });
}

/** `dir` and its ancestors up to `stopDir` (inclusive), where Node looks for `node_modules`. */
function directoriesUpTo(dir: string, stopDir: string): string[] {
  const directories: string[] = [];
  for (let current = dir; ; current = path.dirname(current)) {
    directories.push(current);
    const relative = path.relative(stopDir, current);
    if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) break;
    if (path.dirname(current) === current) break;
  }
  return directories;
}

const MANIFEST_DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;
/** Fields a package that ships styled-jsx precompiled declares it in. */
const STYLED_JSX_DEPENDENCY_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"];

async function readDependencyNames(
  manifestFile: string,
  fields: readonly string[],
): Promise<string[] | null> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  } catch {
    return null;
  }
  if (typeof manifest !== "object" || manifest === null) return null;
  return fields.flatMap((field) => {
    const dependencies = (manifest as Record<string, unknown>)[field];
    return typeof dependencies === "object" && dependencies !== null
      ? Object.keys(dependencies)
      : [];
  });
}

/**
 * Whether the project (or a linked workspace package) installs styled-jsx, or
 * a direct dependency that declares it — one that ships `<style jsx>`
 * precompiled. Its `import`/`require()` of `styled-jsx/style` registers the
 * runtime only once it loads, possibly lazily and after the first render began,
 * and no source scan sees it. `next` always depends on styled-jsx and does not
 * count. Reads each manifest once.
 */
async function dependenciesUseStyledJsx(
  roots: readonly string[],
  workspaceRoot: string,
): Promise<boolean> {
  for (const root of roots) {
    const names = await readDependencyNames(
      path.join(root, "package.json"),
      MANIFEST_DEPENDENCY_FIELDS,
    );
    if (!names) continue;
    if (names.includes("styled-jsx")) return true;
    const declared = await Promise.all(
      names
        .filter((name) => name !== "next")
        .map(async (name) => {
          for (const dir of directoriesUpTo(root, workspaceRoot)) {
            const installed = await readDependencyNames(
              path.join(dir, "node_modules", name, "package.json"),
              STYLED_JSX_DEPENDENCY_FIELDS,
            );
            if (installed) return installed.includes("styled-jsx");
          }
          return false;
        }),
    );
    if (declared.some(Boolean)) return true;
  }
  return false;
}

/**
 * Source directories of packages linked into the project's dependencies —
 * workspace packages, which Vite compiles (and this plugin transforms) as
 * source rather than as dependencies. pnpm links them into the project's own
 * `node_modules`, npm and yarn workspaces into the workspace root's, so every
 * `node_modules` from `root` up to `workspaceRoot` is checked. Only symlinked
 * entries whose real path is outside every `node_modules` count.
 */
async function findLinkedSourceRoots(root: string, workspaceRoot: string): Promise<string[]> {
  const nodeModulesDirs = directoriesUpTo(root, workspaceRoot).map((dir) =>
    path.join(dir, "node_modules"),
  );
  const linkedRoots = new Set<string>();
  const addIfLinked = async (entryPath: string) => {
    try {
      if (!(await lstat(entryPath)).isSymbolicLink()) return;
      const target = toSlash(await realpath(entryPath));
      if (NODE_MODULES_PATH_RE.test(`${target}/`)) return;
      if (!(await stat(target)).isDirectory()) return;
      linkedRoots.add(target);
    } catch {}
  };
  const readNames = (dir: string) => readdir(dir).catch((): string[] => []);
  await Promise.all(
    nodeModulesDirs.map(async (nodeModules) => {
      const names = (await readNames(nodeModules)).filter((name) => !name.startsWith("."));
      await Promise.all(
        names.map(async (name) => {
          if (!name.startsWith("@")) return addIfLinked(path.join(nodeModules, name));
          const scoped = await readNames(path.join(nodeModules, name));
          await Promise.all(
            scoped.map((scopedName) => addIfLinked(path.join(nodeModules, name, scopedName))),
          );
        }),
      );
    }),
  );
  return [...linkedRoots].sort();
}

/**
 * Whether any source file under `roots` uses styled-jsx (`sourceUsesStyledJsx`).
 * Dev compiles modules on demand, so without this a module that is only loaded
 * lazily would not have been compiled (and registered styled-jsx) before the
 * first render that needs it. Reads each file once and stops at the first
 * match.
 */
async function scanSourcesForStyledJsx(roots: readonly string[]): Promise<boolean> {
  const containsStyledJsx = async (files: string[]) =>
    (
      await Promise.all(
        files.map((file) =>
          readFile(file, "utf8").then(
            (source) => sourceUsesStyledJsx(source, file),
            () => false,
          ),
        ),
      )
    ).some(Boolean);
  for (const root of roots) {
    let batch: string[] = [];
    try {
      for await (const file of glob(SOURCE_SCAN_GLOB, {
        cwd: root,
        exclude: isExcludedFromSourceScan,
      })) {
        batch.push(path.join(root, file));
        if (batch.length < SOURCE_SCAN_BATCH_SIZE) continue;
        if (await containsStyledJsx(batch)) return true;
        batch = [];
      }
      if (await containsStyledJsx(batch)) return true;
    } catch {}
  }
  return false;
}

/** Exposed to vinext's dev servers through `plugin.api`. */
export type StyledJsxPluginApi = {
  /**
   * Whether the project uses styled-jsx: a module compiled by this plugin
   * used it; the project installs styled-jsx or a dependency shipping it
   * precompiled (`dependenciesUseStyledJsx`); a one-time scan of the project's
   * (and linked packages') sources finds it; or a source file added or
   * changed since then does. Dev loads `STYLED_JSX_SSR_REGISTRY_ID` up front
   * when this is true, so lazily loaded modules' rules are collected on the
   * first render too. Builds do not need it: they see the whole module graph
   * (see `renderChunk`).
   */
  projectUsesStyledJsx(): Promise<boolean>;
};

function hasStyledJsxTag(source: string, id: string): boolean {
  const cleanId = stripViteModuleQuery(id);
  const extension = path.extname(cleanId);
  const lang = extension === ".ts" || extension === ".mts" || extension === ".cts" ? "ts" : "tsx";
  let ast: ReturnType<typeof parseAst>;
  try {
    ast = parseAst(source, { lang });
  } catch {
    return false;
  }

  let found = false;
  walkAst(ast, (node) => {
    if (found) return false;
    if (node.type === "JSXOpeningElement") {
      const name = node.name;
      if (name.type === "JSXIdentifier" && name.name === "style") {
        if (
          node.attributes.some((attribute) => {
            if (attribute.type !== "JSXAttribute") return false;
            return attribute.name.type === "JSXIdentifier" && attribute.name.name === "jsx";
          })
        ) {
          found = true;
          return false;
        }
      }
    }
  });
  return found;
}

/**
 * Whether a source module uses styled-jsx: a `<style jsx>` element or a
 * `styled-jsx/css` import. The transform compiles exactly these modules, and
 * the dev scan and watcher apply the same test, so they cannot disagree — and
 * a comment that mentions `<style jsx>` does not count.
 */
function sourceUsesStyledJsx(source: string, file: string): boolean {
  if (!STYLED_JSX_SOURCE_RE.test(source)) return false;
  return STYLED_JSX_CSS_RE.test(source) || hasStyledJsxTag(source, file);
}

/**
 * Pages Router SSR (and App Router SSR of client components) runs in server
 * environments other than `rsc`. RSC cannot render styled-jsx (it imports
 * `client-only`), so the registration import is skipped there.
 */
function shouldRegisterSsrRuntime(environment: Environment | undefined): boolean {
  return environment?.config.consumer === "server" && environment.name !== "rsc";
}

/**
 * styled-jsx only ships CommonJS. Resolving it from Next's dependency graph
 * (below) bypasses Vite's resolver, and with it the dependency optimizer that
 * normally converts CommonJS for dev — so the browser, the Workers runner and
 * the Pages Router SSR runner all received raw `module.exports` code. Register
 * the resolved file with a discovering optimizer, exactly as Vite's own
 * `vite:pre-alias` plugin does for aliased dependencies.
 */
function registerOptimizedDependency(
  environment: Environment | undefined,
  source: string,
  resolved: string,
  scan: boolean | undefined,
): string | null {
  if (scan || environment?.mode !== "dev") return null;
  const depsOptimizer = (environment as DevEnvironment).depsOptimizer;
  if (!depsOptimizer || depsOptimizer.options.noDiscovery) return null;
  const exclude = depsOptimizer.options.exclude ?? [];
  if (exclude.includes("styled-jsx") || exclude.includes(source)) return null;
  return depsOptimizer.getOptimizedDepId(depsOptimizer.registerMissingImport(source, resolved));
}

/**
 * Server environments do not discover dependencies. App Router dev still runs
 * styled-jsx through `@vitejs/plugin-rsc`'s CommonJS transform, but the Pages
 * Router SSR runner has no such transform. When the runner lives in this Node
 * process and already loads React natively, require styled-jsx natively too so
 * it shares that React instance with the page being rendered.
 */
function shouldLoadNatively(environment: Environment | undefined): boolean {
  if (
    !environment ||
    environment.mode !== "dev" ||
    environment.config.consumer !== "server" ||
    !isRunnableDevEnvironment(environment)
  ) {
    return false;
  }
  const external = environment.config.resolve.external;
  return external === true || (Array.isArray(external) && external.includes("react"));
}

function createNativeModuleFacade(file: string): string {
  const require = createRequire(file);
  const loaded: unknown = require(file);
  const exportNames =
    (typeof loaded === "object" && loaded !== null) || typeof loaded === "function"
      ? Object.keys(loaded).filter((name) => name !== "default" && JS_IDENTIFIER_RE.test(name))
      : [];
  const fileLiteral = JSON.stringify(file);
  return [
    `import { createRequire } from "node:module";`,
    `const mod = createRequire(${fileLiteral})(${fileLiteral});`,
    `export default mod;`,
    ...exportNames.map((name) => `export const ${name} = mod.${name};`),
    "",
  ].join("\n");
}

/**
 * A server build's registration module, emitted as its own chunk so entries
 * can load it eagerly (see `renderChunk` below).
 */
type EagerRegistration = {
  chunkReferenceId: string;
  /** Resolved id of `vinext/shims/styled-jsx-registry` in this build. */
  registryShimId: string;
};

type RenderedChunkGraph = Record<
  string,
  { readonly imports: readonly string[]; readonly moduleIds: readonly string[] }
>;

/** File names of the chunks `fileName` loads statically, itself included. */
function collectStaticChunkClosure(fileName: string, chunks: RenderedChunkGraph): Set<string> {
  const closure = new Set([fileName]);
  for (const current of closure) {
    for (const imported of chunks[current]?.imports ?? []) closure.add(imported);
  }
  return closure;
}

/**
 * Whether a chunk the runtime loads on its own (an entry, or a dynamic import
 * such as a multi-stage Worker's response stage) statically loads the Pages
 * styled-jsx registry — so it renders Pages — without statically loading the
 * registration module: styled-jsx is then only used by lazily imported
 * modules (`next/dynamic`, `React.lazy`), which would register it only after
 * the first render began.
 */
function chunkNeedsEagerStyledJsxRegistration(
  fileName: string,
  chunks: RenderedChunkGraph,
  registryShimId: string,
): boolean {
  let loadsRegistryShim = false;
  for (const loaded of collectStaticChunkClosure(fileName, chunks)) {
    const moduleIds = chunks[loaded]?.moduleIds ?? [];
    if (moduleIds.includes(RESOLVED_STYLED_JSX_SSR_REGISTRY_ID)) return false;
    if (moduleIds.includes(registryShimId)) loadsRegistryShim = true;
  }
  return loadsRegistryShim;
}

function createProjectRequire(projectRoot: string) {
  return createRequire(path.join(projectRoot, "package.json"));
}

function resolveNextRequire(projectRoot: string): NodeJS.Require | null {
  try {
    const projectRequire = createProjectRequire(projectRoot);
    return createRequire(projectRequire.resolve("next/package.json"));
  } catch {
    return null;
  }
}

function parserOptions(id: string): Record<string, unknown> {
  const extension = path.extname(stripViteModuleQuery(id));
  if (extension === ".ts" || extension === ".tsx") {
    return { syntax: "typescript", tsx: extension === ".tsx", decorators: true };
  }
  return { syntax: "ecmascript", jsx: true };
}

export function createStyledJsxPlugin(
  initialProjectRoot: string,
  options: StyledJsxPluginOptions = {},
): Plugin<StyledJsxPluginApi> {
  let projectRoot = initialProjectRoot;
  let development = false;
  let nextRequire: NodeJS.Require | null | undefined;
  let compilerPromise: Promise<NextSwcModule> | null = null;
  const importModule = options.importModule ?? ((url: string) => import(url));
  /** Per build: the emitted registration chunk `renderChunk` imports. */
  const eagerRegistrations = new WeakMap<Environment, EagerRegistration>();
  /**
   * Across builds of an environment: the registry shim id, once a build has
   * loaded the registration. A watch rebuild can restore that module from its
   * module cache without rerunning `load`, so `buildStart` re-emits from here.
   */
  const registryShimIds = new WeakMap<Environment, string>();

  function emitEagerRegistration(
    context: { emitFile(file: { type: "chunk"; id: string; name: string }): string },
    environment: Environment,
    registryShimId: string,
  ): void {
    registryShimIds.set(environment, registryShimId);
    if (eagerRegistrations.has(environment)) return;
    eagerRegistrations.set(environment, {
      // Emitted entries go through resolveId, which maps the public id.
      chunkReferenceId: context.emitFile({
        type: "chunk",
        id: STYLED_JSX_SSR_REGISTRY_ID,
        name: "styled-jsx-registry",
      }),
      registryShimId,
    });
  }

  function getNextRequire(): NodeJS.Require | null {
    nextRequire ??= resolveNextRequire(projectRoot);
    return nextRequire;
  }

  async function getCompiler(): Promise<NextSwcModule> {
    if (!compilerPromise) {
      const requireFromNext = getNextRequire();
      if (!requireFromNext) {
        throw new Error(
          "[vinext] styled-jsx requires an installed next package so vinext can use its matching compiler.",
        );
      }
      const compilerPath = requireFromNext.resolve("next/dist/build/swc");
      compilerPromise = importModule(pathToFileURL(compilerPath).href).then(async (compiler) => {
        await compiler.loadBindings();
        return compiler;
      });
    }
    return compilerPromise;
  }

  function resolveStyledJsx(source: string): string | null {
    try {
      return getNextRequire()?.resolve(source) ?? null;
    } catch {}

    try {
      return createProjectRequire(projectRoot).resolve(source);
    } catch {
      return null;
    }
  }

  /**
   * Whether the styled-jsx runtime the registration imports can be loaded.
   * Source matches — the startup scan's and those of files changed since —
   * only count when it can: their regex also matches comments and strings,
   * and vinext does not require Next.js (or styled-jsx) to be installed.
   */
  function canLoadStyledJsxRuntime(): boolean {
    return resolveStyledJsx("styled-jsx") !== null;
  }

  // Dev usage detection (see `StyledJsxPluginApi.projectUsesStyledJsx`).
  let compiledStyledJsx = false;
  let sourceScan: Promise<boolean> | undefined;
  /** The project root plus linked workspace packages' source (see the scan). */
  let sourceRoots: string[] = [projectRoot];
  /** A source file added or changed after the scan uses styled-jsx. */
  let changedSourceUsesStyledJsx = false;
  /** `STYLED_JSX_DEV_REGISTRATION_ID` was served without the registration. */
  let devRegistrationServedWithout = false;
  let devServer: ViteDevServer | undefined;

  async function scanProjectSources(): Promise<boolean> {
    const root = projectRoot;
    let realRoot = root;
    try {
      realRoot = toSlash(await realpath(root));
    } catch {}
    const isOutside = (from: string, to: string) => path.relative(from, to).startsWith("../");
    const workspaceRoot = searchForWorkspaceRoot(root);
    // Skip links to the project itself, into it, or to a directory holding it.
    const linkedRoots = (await findLinkedSourceRoots(root, workspaceRoot)).filter(
      (linked) => isOutside(realRoot, linked) && isOutside(linked, realRoot),
    );
    const roots = [root, ...linkedRoots];
    if (root === projectRoot) sourceRoots = roots;
    return (
      (await dependenciesUseStyledJsx(roots, workspaceRoot)) ||
      (await scanSourcesForStyledJsx(roots))
    );
  }

  async function projectUsesStyledJsx(): Promise<boolean> {
    if (compiledStyledJsx || changedSourceUsesStyledJsx) return true;
    sourceScan ??= canLoadStyledJsxRuntime() ? scanProjectSources() : Promise.resolve(false);
    return (await sourceScan) || compiledStyledJsx || changedSourceUsesStyledJsx;
  }

  /**
   * Generated dev entries import `STYLED_JSX_DEV_REGISTRATION_ID`, which their
   * module runners cache. Once the project starts using styled-jsx, reload it
   * (and so the entries importing it) wherever it was served empty. Hand
   * styled-jsx to a discovering dependency optimizer now, too: discovering it
   * during the next render would re-optimize (and swap React copies) mid-way.
   */
  function refreshDevRegistration(): void {
    if (!devRegistrationServedWithout || !devServer) return;
    devRegistrationServedWithout = false;
    for (const environment of Object.values(devServer.environments)) {
      const module = environment.moduleGraph.getModuleById(RESOLVED_STYLED_JSX_DEV_REGISTRATION_ID);
      if (!module) continue;
      for (const source of ["styled-jsx", "styled-jsx/style"]) {
        const resolved = resolveStyledJsx(source);
        if (resolved) registerOptimizedDependency(environment, source, resolved, false);
      }
      environment.moduleGraph.invalidateModule(module);
      environment.hot.send({ type: "full-reload" });
    }
  }

  return {
    name: "vinext:styled-jsx",
    enforce: "pre",
    api: { projectUsesStyledJsx },
    configResolved(config) {
      development = config.command === "serve";
      if (config.root !== projectRoot) {
        projectRoot = config.root;
        nextRequire = undefined;
        compilerPromise = null;
        sourceScan = undefined;
        sourceRoots = [projectRoot];
      }
    },
    configureServer(server) {
      devServer = server;
    },
    /**
     * The source scan runs once, so a negative result would otherwise hide
     * styled-jsx added later in the session to a module that is only loaded
     * lazily (and so is not compiled before the render that needs it). Check
     * each added or changed source file instead of rescanning. Synchronous so
     * the answer is in place before the next request is handled.
     */
    watchChange(id, change) {
      if (!development || change.event === "delete") return;
      if (
        !compiledStyledJsx &&
        !changedSourceUsesStyledJsx &&
        sourceScan &&
        path.basename(id) === "package.json" &&
        isInsideSourceRoots(sourceRoots, id)
      ) {
        // A dependency may have been added: check the manifests (and
        // sources) again, then reload generated entries if that changed.
        sourceScan = undefined;
        void projectUsesStyledJsx().then((uses) => {
          if (uses) refreshDevRegistration();
        });
        return;
      }
      if (!compiledStyledJsx && !changedSourceUsesStyledJsx) {
        if (!isScannedSourceFile(sourceRoots, id) || !canLoadStyledJsxRuntime()) return;
        let source: string;
        try {
          source = readFileSync(id, "utf8");
        } catch {
          return;
        }
        if (!sourceUsesStyledJsx(source, id)) return;
        changedSourceUsesStyledJsx = true;
      }
      refreshDevRegistration();
    },
    buildStart() {
      const environment = this.environment;
      if (!environment) return;
      // Emitted files belong to one build. A watch rebuild of an environment
      // that loaded the registration before emits it again up front, since a
      // cached registration module does not rerun `load`; `renderChunk` skips
      // it if this build no longer uses styled-jsx.
      eagerRegistrations.delete(environment);
      const registryShimId = registryShimIds.get(environment);
      if (registryShimId) emitEagerRegistration(this, environment, registryShimId);
    },
    resolveId: {
      filter: { id: STYLED_JSX_RESOLVE_ID_RE },
      handler(source, importer, resolveOptions) {
        if (source === STYLED_JSX_SSR_REGISTRY_ID) return RESOLVED_STYLED_JSX_SSR_REGISTRY_ID;
        if (source === STYLED_JSX_DEV_REGISTRATION_ID) {
          return RESOLVED_STYLED_JSX_DEV_REGISTRATION_ID;
        }
        const environment = this?.environment;
        if (
          source === "styled-jsx/style" &&
          importer !== RESOLVED_STYLED_JSX_STYLE_ID &&
          importer !== RESOLVED_STYLED_JSX_STYLE_CJS_ID &&
          importer !== RESOLVED_STYLED_JSX_SSR_REGISTRY_ID &&
          shouldRegisterSsrRuntime(environment)
        ) {
          // Rolldown reports how a module is requested; Vite dev does not.
          const kind = (resolveOptions as { kind?: string } | undefined)?.kind;
          return kind === "require-call"
            ? RESOLVED_STYLED_JSX_STYLE_CJS_ID
            : RESOLVED_STYLED_JSX_STYLE_ID;
        }
        const resolved = resolveStyledJsx(source);
        if (!resolved) return null;
        // Vite passes `scan` while crawling for dependencies; it is not part
        // of the public resolveId options type.
        const scan = (resolveOptions as { scan?: boolean } | undefined)?.scan;
        const optimized = registerOptimizedDependency(environment, source, resolved, scan);
        if (optimized) return optimized;
        if (shouldLoadNatively(environment)) return STYLED_JSX_NODE_MODULE_PREFIX + resolved;
        return resolved;
      },
    },
    load: {
      filter: { id: STYLED_JSX_LOAD_RE },
      async handler(id) {
        if (id === RESOLVED_STYLED_JSX_STYLE_ID) return STYLED_JSX_STYLE_CODE;
        if (id === RESOLVED_STYLED_JSX_STYLE_CJS_ID) return STYLED_JSX_STYLE_CJS_CODE;
        if (id === RESOLVED_STYLED_JSX_DEV_REGISTRATION_ID) {
          if (await projectUsesStyledJsx()) {
            return `import ${JSON.stringify(STYLED_JSX_SSR_REGISTRY_ID)};\n`;
          }
          devRegistrationServedWithout = true;
          return "export {};\n";
        }
        if (id !== RESOLVED_STYLED_JSX_SSR_REGISTRY_ID) {
          return createNativeModuleFacade(id.slice(STYLED_JSX_NODE_MODULE_PREFIX.length));
        }
        // Loaded only once a module this plugin compiled uses styled-jsx, so
        // apps without styled-jsx never reach this. In a server build, emit
        // the registration as its own chunk: when every styled-jsx module is
        // loaded lazily, `renderChunk` makes Pages entries import it up front.
        const environment = this?.environment;
        if (environment?.mode === "build" && environment.config.consumer === "server") {
          const registryShim = await this.resolve(STYLED_JSX_REGISTRY_SHIM, id);
          if (registryShim && !registryShim.external) {
            emitEagerRegistration(this, environment, registryShim.id);
          }
        }
        return STYLED_JSX_SSR_REGISTRY_CODE;
      },
    },
    /**
     * Next.js wraps every Pages render in styled-jsx's registry, so styles
     * from modules loaded lazily (`next/dynamic`, `React.lazy`) are collected
     * on the first render too. vinext only wraps renders once styled-jsx has
     * registered, which a lazily loaded module would do too late: after the
     * first render of each server instance (a Workers isolate, a prerender, a
     * first ISR render) began. Entry and dynamically imported chunks that
     * render Pages but reach styled-jsx only lazily therefore import the
     * registration chunk statically.
     *
     * Appended rather than prepended so existing source-map lines are kept;
     * ES imports are hoisted, so it still runs before the chunk's body. Dev
     * keeps registering lazily: it has no bundle graph to inspect up front.
     */
    renderChunk(code, chunk, outputOptions, meta) {
      if ((!chunk.isEntry && !chunk.isDynamicEntry) || outputOptions.format !== "es") return null;
      const environment = this.environment;
      const eager = environment ? eagerRegistrations.get(environment) : undefined;
      if (
        !eager ||
        !chunkNeedsEagerStyledJsxRegistration(chunk.fileName, meta.chunks, eager.registryShimId)
      ) {
        return null;
      }
      // Re-emitted by `buildStart` but no longer imported by any module.
      const registration = this.getModuleInfo(RESOLVED_STYLED_JSX_SSR_REGISTRY_ID);
      if (!registration?.importers.length && !registration?.dynamicImporters.length) return null;
      const registrationFileName = this.getFileName(eager.chunkReferenceId);
      // Never import a chunk the registration itself depends on (a cycle).
      if (collectStaticChunkClosure(registrationFileName, meta.chunks).has(chunk.fileName)) {
        return null;
      }
      let specifier = path.relative(path.dirname(chunk.fileName), registrationFileName);
      if (!specifier.startsWith(".")) specifier = `./${specifier}`;
      const output = new MagicString(code);
      output.append(`\nimport ${JSON.stringify(specifier)};\n`);
      return { code: output.toString(), map: output.generateMap({ hires: "boundary" }) };
    },
    transform: {
      filter: {
        id: {
          include: SCRIPT_MODULE_ID_RE,
          exclude: NODE_MODULES_PATH_RE,
        },
        code: STYLED_JSX_SOURCE_RE,
      },
      async handler(source, id) {
        if (NODE_MODULES_PATH_RE.test(stripViteModuleQuery(id))) return null;
        if (!sourceUsesStyledJsx(source, id)) return null;
        if (!getNextRequire()) {
          throw new Error(
            "[vinext] styled-jsx requires an installed next package so vinext can use its matching compiler.",
          );
        }
        const compiler = await getCompiler();
        const result = await compiler.transform(source, {
          filename: stripViteModuleQuery(id),
          sourceMaps: true,
          module: { type: "es6" },
          // Next's compiler strips getServerSideProps/getStaticProps unless
          // told otherwise; Next.js itself disables that for server compiles.
          // vinext's strip-server-exports plugin owns client-side stripping,
          // so keep data-fetching exports intact in every environment.
          disableNextSsg: true,
          styledJsx: { useLightningcss: false },
          jsc: {
            parser: parserOptions(id),
            transform: {
              react: {
                runtime: "automatic",
                development,
                useBuiltins: true,
              },
              optimizer: { simplify: false },
            },
          },
        });
        compiledStyledJsx = true;
        // The compiled `styled-jsx/style` import registers the runtime on the
        // server (see `RESOLVED_STYLED_JSX_STYLE_ID`).
        return { code: result.code, map: result.map ?? null };
      },
    },
  };
}
