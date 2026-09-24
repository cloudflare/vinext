import { readFileSync, realpathSync } from "node:fs";
import { glob, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path, { toSlash } from "pathslash";
import { pathToFileURL } from "node:url";
import MagicString from "magic-string";
import {
  isRunnableDevEnvironment,
  parseAst,
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
 * `render.tsx` does. Only modules this plugin compiles import it, which keeps
 * styled-jsx out of server bundles for apps that never use it.
 */
export const STYLED_JSX_SSR_REGISTRY_ID = "virtual:vinext-styled-jsx-ssr-registry";
const RESOLVED_STYLED_JSX_SSR_REGISTRY_ID = "\0" + STYLED_JSX_SSR_REGISTRY_ID;
/**
 * Dev only: imported by the generated Pages entries (Cloudflare and hybrid
 * dev). Imports `STYLED_JSX_SSR_REGISTRY_ID` when the project uses styled-jsx
 * and is empty otherwise; reloaded if the project starts using it.
 */
export const STYLED_JSX_DEV_REGISTRATION_ID = "virtual:vinext-styled-jsx-dev-registration";
const RESOLVED_STYLED_JSX_DEV_REGISTRATION_ID = "\0" + STYLED_JSX_DEV_REGISTRATION_ID;
const STYLED_JSX_RESOLVE_ID_RE =
  /^(?:styled-jsx(?:\/.*)?|virtual:vinext-styled-jsx-(?:ssr-registry|dev-registration))$/;
const STYLED_JSX_STYLE_IMPORT_RE = /["']styled-jsx\/style["']/;
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
  /^\0(?:virtual:vinext-styled-jsx-(?:ssr-registry|dev-registration)$|vinext-styled-jsx-node:)/;
const JS_IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;
const STYLED_JSX_SOURCE_RE =
  /(?:<style\b|from\s+["']styled-jsx\/css["']|require\s*\(\s*["']styled-jsx\/css["']\s*\))/;
const STYLED_JSX_CSS_RE =
  /(?:from\s+["']styled-jsx\/css["']|require\s*\(\s*["']styled-jsx\/css["']\s*\))/;
/**
 * Dev source scan: a `<style … jsx>` element or a `styled-jsx/css` import.
 * Stricter than `STYLED_JSX_SOURCE_RE` (which also matches plain `<style>`),
 * since there is no AST check behind it.
 */
const STYLED_JSX_USAGE_RE = /<style\b[^>]*\sjsx(?=[\s=/>])|["']styled-jsx\/css["']/;
const SOURCE_SCAN_GLOB = "**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}";
const SOURCE_SCAN_BATCH_SIZE = 64;

const SOURCE_SCAN_FILE_RE = /\.(?:jsx?|tsx?|[cm][jt]s)$/;

/** Skip dependencies, dot directories (VCS, caches) and vinext's build output. */
function isExcludedFromSourceScan(entry: string): boolean {
  const name = entry.slice(Math.max(entry.lastIndexOf("/"), entry.lastIndexOf("\\")) + 1);
  return name === "node_modules" || name === "dist" || name.startsWith(".");
}

/**
 * Whether the source scan of `root` covers `file` (an absolute path). File
 * watchers can report real paths for a root reached through a symlink, so
 * the root's real path counts too.
 */
function isScannedSourceFile(root: string, file: string): boolean {
  if (!SOURCE_SCAN_FILE_RE.test(file)) return false;
  let realRoot = root;
  try {
    realRoot = toSlash(realpathSync.native(root));
  } catch {}
  return [root, realRoot].some((candidate) => {
    const relative = path.relative(candidate, file);
    if (relative.startsWith("../") || path.isAbsolute(relative)) return false;
    return !relative.split("/").some(isExcludedFromSourceScan);
  });
}

/**
 * Whether any source file under `root` uses styled-jsx. Dev compiles modules
 * on demand, so without this a module that is only loaded lazily would not
 * have been compiled (and registered styled-jsx) before the first render that
 * needs it. Reads each file once and stops at the first match.
 */
async function scanSourcesForStyledJsx(root: string): Promise<boolean> {
  const containsStyledJsx = async (files: string[]) =>
    (
      await Promise.all(
        files.map((file) =>
          readFile(path.join(root, file), "utf8").then(
            (source) => STYLED_JSX_USAGE_RE.test(source),
            () => false,
          ),
        ),
      )
    ).some(Boolean);
  let batch: string[] = [];
  try {
    for await (const file of glob(SOURCE_SCAN_GLOB, {
      cwd: root,
      exclude: isExcludedFromSourceScan,
    })) {
      batch.push(file);
      if (batch.length < SOURCE_SCAN_BATCH_SIZE) continue;
      if (await containsStyledJsx(batch)) return true;
      batch = [];
    }
    return await containsStyledJsx(batch);
  } catch {
    return false;
  }
}

/** Exposed to vinext's dev servers through `plugin.api`. */
export type StyledJsxPluginApi = {
  /**
   * Whether the project uses styled-jsx: a module compiled by this plugin
   * used it, a one-time scan of the project's sources finds it, or a source
   * file added or changed since then does. Dev loads
   * `STYLED_JSX_SSR_REGISTRY_ID` up front when this is true, so lazily loaded
   * modules' rules are collected on the first render too. Builds do not need
   * it: they see the whole module graph (see `renderChunk`).
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

  // Dev usage detection (see `StyledJsxPluginApi.projectUsesStyledJsx`).
  let compiledStyledJsx = false;
  let sourceScan: Promise<boolean> | undefined;
  /** A source file added or changed after the scan uses styled-jsx. */
  let changedSourceUsesStyledJsx = false;
  /** `STYLED_JSX_DEV_REGISTRATION_ID` was served without the registration. */
  let devRegistrationServedWithout = false;
  let devServer: ViteDevServer | undefined;

  async function projectUsesStyledJsx(): Promise<boolean> {
    if (compiledStyledJsx || changedSourceUsesStyledJsx) return true;
    // Without styled-jsx the registration cannot load (a scan false positive
    // such as a commented-out `<style jsx>` must not break dev).
    sourceScan ??= resolveStyledJsx("styled-jsx")
      ? scanSourcesForStyledJsx(projectRoot)
      : Promise.resolve(false);
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
      if (!compiledStyledJsx && !changedSourceUsesStyledJsx) {
        if (!isScannedSourceFile(projectRoot, id)) return;
        let source: string;
        try {
          source = readFileSync(id, "utf8");
        } catch {
          return;
        }
        if (!STYLED_JSX_USAGE_RE.test(source)) return;
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
      handler(source, _importer, resolveOptions) {
        if (source === STYLED_JSX_SSR_REGISTRY_ID) return RESOLVED_STYLED_JSX_SSR_REGISTRY_ID;
        if (source === STYLED_JSX_DEV_REGISTRATION_ID) {
          return RESOLVED_STYLED_JSX_DEV_REGISTRATION_ID;
        }
        const resolved = resolveStyledJsx(source);
        if (!resolved) return null;
        const environment = this?.environment;
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
        const hasStyledJsxCss = STYLED_JSX_CSS_RE.test(source);
        const hasStyledJsxElement = !hasStyledJsxCss && hasStyledJsxTag(source, id);
        if (!hasStyledJsxCss && !hasStyledJsxElement) return null;
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
        // Appended (not prepended) so the compiler's source map stays aligned;
        // ES imports are hoisted, so registration still runs before any render.
        const code =
          shouldRegisterSsrRuntime(this?.environment) &&
          STYLED_JSX_STYLE_IMPORT_RE.test(result.code)
            ? `${result.code}\nimport ${JSON.stringify(STYLED_JSX_SSR_REGISTRY_ID)};\n`
            : result.code;
        return { code, map: result.map ?? null };
      },
    },
  };
}
