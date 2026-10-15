import { toSlash } from "pathslash";
import { parseAst, type Plugin } from "vite";
import { stripViteModuleQuery } from "../utils/path.js";
import { isServerEnvironment } from "./environment.js";

// Ported from Next.js `assert_client_graph`:
// crates/next-custom-transforms/src/transforms/react_server_components.rs
// `server-only` is on the same list there; vinext validates it separately in
// `vinext:validate-server-only-client-imports`.
const INVALID_CLIENT_IMPORTS: ReadonlySet<string> = new Set(["next/headers", "next/root-params"]);
const INVALID_CLIENT_LIB_APIS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["next/server", new Set(["after"])],
  [
    "next/cache",
    new Set([
      "revalidatePath",
      "revalidateTag",
      "cacheLife",
      "unstable_cacheLife",
      "cacheTag",
      "unstable_cacheTag",
    ]),
  ],
]);

// Every checked specifier is a string literal starting with "next/", unless
// it is spelled with escapes ("next\u002fheaders", "next\/headers") that only
// the parsed AST decodes; any escape needs a backslash. The quote matters:
// paths such as dev JSX `fileName`s often contain "vinext/".
const SERVER_API_CANDIDATE_RE = /["']next\/|\\/;
const USE_CLIENT_CANDIDATE_RE = /\buse client\b/;
const CANDIDATE_MODULE_RE = /["']next\/|\\|\buse client\b/;

type InvalidClientImport = {
  /** The module specifier, or the imported API name for library APIs. */
  name: string;
  start: number;
};

type ModuleItem = ReturnType<typeof parseAst>["body"][number];

function readImportedName(specifier: unknown): string | null {
  if (!specifier || typeof specifier !== "object") return null;
  const node = specifier as {
    type?: string;
    imported?: { type?: string; name?: unknown; value?: unknown };
  };
  if (node.type !== "ImportSpecifier" || !node.imported) return null;
  const name = node.imported.type === "Identifier" ? node.imported.name : node.imported.value;
  return typeof name === "string" ? name : null;
}

/** Directives match by decoded value, as Next.js does (`"use\u0020client"` counts). */
function hasDirective(body: ModuleItem[], matches: (directive: string) => boolean): boolean {
  for (const item of body) {
    if (item.type !== "ExpressionStatement" || typeof item.directive !== "string") return false;
    const { expression } = item;
    if (expression.type === "Literal" && typeof expression.value === "string") {
      if (matches(expression.value)) return true;
    }
  }
  return false;
}

type ClientGraphModuleInfo = {
  /** Whether the module starts a `"use client"` boundary. */
  isClientBoundary: boolean;
  /** Whether the module has a module-level `"use server"` or `"use cache"` directive. */
  isServerModule: boolean;
  invalidImports: InvalidClientImport[];
};

/**
 * Runs on final module code. Server Function and cache modules (which Next.js
 * skips) need no exemption: @vitejs/plugin-rsc and `vinext:use-cache-callable`
 * have already replaced them with server reference proxies that keep none of
 * their imports, while one they did not replace (in a Web Worker bundle, a
 * virtual module, or added by a later plugin) still reaches the browser.
 */
function analyzeClientGraphModule(code: string): ClientGraphModuleInfo {
  const none: ClientGraphModuleInfo = {
    isClientBoundary: false,
    isServerModule: false,
    invalidImports: [],
  };
  if (!CANDIDATE_MODULE_RE.test(code)) return none;

  let body: ModuleItem[];
  try {
    body = parseAst(code).body;
  } catch {
    return none;
  }
  const invalidImports: InvalidClientImport[] = [];
  for (const item of body) {
    if (item.type !== "ImportDeclaration") continue;
    const source = item.source.value;
    if (typeof source !== "string") continue;

    if (INVALID_CLIENT_IMPORTS.has(source)) {
      invalidImports.push({ name: source, start: item.start });
    }

    const invalidApis = INVALID_CLIENT_LIB_APIS.get(source);
    if (!invalidApis) continue;
    for (const specifier of item.specifiers) {
      const imported = readImportedName(specifier);
      if (imported && invalidApis.has(imported)) {
        invalidImports.push({ name: imported, start: specifier.start });
      }
    }
  }
  return {
    isClientBoundary: hasDirective(body, (directive) => directive === "use client"),
    isServerModule: hasDirective(
      body,
      (directive) =>
        directive === "use server" ||
        directive === "use cache" ||
        directive.startsWith("use cache: "),
    ),
    invalidImports,
  };
}

/**
 * Find the server-only APIs a module imports, in source order. Like Next.js,
 * only top-level static `import` declarations count, the source must match
 * exactly, and library APIs match by imported (not local) name.
 */
export function findInvalidClientImports(code: string): InvalidClientImport[] {
  return analyzeClientGraphModule(code).invalidImports;
}

/**
 * Next.js picks the message by whether the importing file's path starts with
 * the app directory (a plain prefix match, as Next.js does).
 */
export function createInvalidClientImportMessage(
  name: string,
  moduleId: string,
  appDir: string | null,
): string {
  if (appDir && moduleId.startsWith(appDir)) {
    return `You're importing a module that depends on "${name}" into a React Client Component module. This API is only available in Server Components but one of its parents is marked with "use client", so this module is also a Client Component.\nLearn more: https://nextjs.org/docs/app/building-your-application/rendering`;
  }
  return `You're importing a module that depends on "${name}". This API is only available in Server Components in the App Router, but you are using it in the Pages Router.\nLearn more: https://nextjs.org/docs/app/building-your-application/rendering/server-components`;
}

type ClientGraphServerApisPluginOptions = {
  /** Canonical, slash-separated App Router directory, or null without one. */
  getAppDir: () => string | null;
  /**
   * Slash-separated file paths of the Pages Router's pages (not API routes)
   * and its root `_app`, `_document` and `_error`, as the router scanned them.
   */
  getPagesPages?: () => Promise<ReadonlySet<string>>;
  /** The generated modules that import the Pages Router's pages. */
  pagesEntryIds?: readonly string[];
  /** Whether this is the dev environment that loads Pages Router pages directly. */
  isPagesDevEnvironment?: (environment: object) => boolean;
  /**
   * For a browser Web Worker's plugin container (`worker.plugins`). Vite
   * bundles every worker separately, and a worker is browser code throughout.
   */
  worker?: boolean;
};

/** Whether `id` is, or is imported (at any depth) by, a client-layer root. */
function isReachableFromClientRoot(
  id: string,
  isClientRoot: (id: string) => boolean,
  getImporters: (id: string) => Iterable<string>,
): boolean {
  const seen = new Set<string>();
  const pending = [id];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (seen.has(next)) continue;
    seen.add(next);
    if (isClientRoot(next)) return true;
    pending.push(...getImporters(next));
  }
  return false;
}

const NODE_MODULES_RE = /\/node_modules\//;

/**
 * The server API import to report for a module, if any. Like Next.js, skip
 * Server Function and cache modules. With an App Router, any that reach this
 * check were not replaced by server reference proxies, so they are checked;
 * Pages-only apps never replace them. Next.js rejects a module that also says
 * "use client", so that one is still checked.
 */
function getReportedInvalidImport(
  info: ClientGraphModuleInfo,
  appDir: string | null,
): InvalidClientImport | undefined {
  if (appDir === null && info.isServerModule && !info.isClientBoundary) return undefined;
  return info.invalidImports[0];
}

type GraphKind = "browser" | "server";

/**
 * The browser graph is client layer throughout. The RSC environment is the
 * react-server layer, which Next.js checks differently. Every other server
 * environment (SSR, or the Worker or Node environment rendering Pages
 * Router pages) mixes client-layer modules with middleware, instrumentation
 * and API routes.
 */
function getGraphKind(
  environment: { name: string; config: { consumer?: string } } | undefined,
  hasAppDir: boolean,
): GraphKind | null {
  if (!environment) return null;
  if (environment.name === "client") return "browser";
  if (!isServerEnvironment(environment)) return null;
  if (hasAppDir && environment.name === "rsc") return null;
  return "server";
}

/** Only App Router SSR renders Client Components in a server graph. */
function tracksClientBoundaries(environmentName: string, appDir: string | null): boolean {
  return appDir !== null && environmentName === "ssr";
}

/**
 * Fail the build when a module in the client layer imports a request API
 * (`next/headers`, `next/root-params`) or a server-only cache/`after` API,
 * matching Next.js' compile error. Client-layer modules are evaluated during
 * SSR, where module-scope `cookies()` or `headers()` would capture the first
 * request that loads them.
 *
 * Like Next.js, the check skips `node_modules`.
 *
 * - The browser graph (and every Web Worker bundle) is client layer
 *   throughout: every module under a `"use client"` boundary plus the Pages
 *   Router's page components, without middleware, instrumentation or Pages
 *   data exports, which are stripped first.
 * - A server graph (SSR, or the environment rendering Pages Router pages)
 *   also holds middleware, instrumentation and API routes, so there a module
 *   is checked only when a `"use client"` module or a Pages Router page
 *   (including `_app`, `_document` and `_error`) imports it, directly or not.
 *   That includes modules only Pages data exports use, and modules that
 *   resolution conditions such as `browser` keep out of the browser graph.
 */
export function createClientGraphServerApisPlugin(
  options: ClientGraphServerApisPluginOptions,
): Plugin {
  // Builds analyze the final module graph at buildEnd, so only dev keeps
  // state: the "use client" modules each server environment has transformed.
  // It belongs to the environment instance, since `server.restart()` reuses
  // this plugin with fresh environments and module graphs.
  const devClientBoundaries = new Map<string, { environment: object; boundaries: Set<string> }>();
  const getDevClientBoundaries = (environment: { name: string }): Set<string> => {
    let state = devClientBoundaries.get(environment.name);
    if (state?.environment !== environment) {
      state = { environment, boundaries: new Set() };
      devClientBoundaries.set(environment.name, state);
    }
    return state.boundaries;
  };
  // Pages pages open the client layer in every server graph. A "use client"
  // module only does in App Router SSR (the "ssr" environment): Pages-only
  // apps and other server environments, such as auxiliary Workers, have no
  // Client Components, so there an inert directive in a module that only an
  // API route, middleware or Worker imports (graphs Next.js leaves
  // unchecked) is ignored.
  // Pages are matched by the exact ids the generated Pages entries import them
  // under in this environment, which follow `resolve.alias` and
  // `resolve.preserveSymlinks`.
  const getClientRootPredicate = async (
    clientBoundaries: ReadonlySet<string>,
    tracksBoundaries: boolean,
    loadsPagesDirectly: boolean,
    isLoaded: (moduleId: string) => boolean,
    resolve: (source: string, importer?: string) => Promise<{ id: string } | null>,
  ): Promise<(moduleId: string) => boolean> => {
    const pagesPages = (await options.getPagesPages?.()) ?? new Set<string>();
    const pageIds = new Set<string>();
    // Only the generated entries an environment loaded import pages, so one
    // without any (such as an auxiliary Worker) has no Pages roots. The dev
    // server's Pages environment also loads each page directly, without an
    // importer.
    const entryIds: Array<string | undefined> = (options.pagesEntryIds ?? []).filter(isLoaded);
    const importers = loadsPagesDirectly ? [...entryIds, undefined] : entryIds;
    await Promise.all(
      [...pagesPages].flatMap((pagePath) =>
        importers.map(async (importer) => {
          const resolved = await resolve(pagePath, importer);
          pageIds.add(resolved?.id ?? pagePath);
        }),
      ),
    );
    return (moduleId) =>
      (tracksBoundaries && clientBoundaries.has(moduleId)) || pageIds.has(moduleId);
  };

  return {
    name: "vinext:validate-client-graph-server-apis",
    // Check the final module code, after every other plugin's transform (an
    // app plugin may add imports), but before Vite's dev import analysis
    // rewrites specifiers.
    enforce: "post",
    // A module that loses its "use client" directive may no longer match the
    // code filter, so drop its boundaries (under any query) when the file
    // changes; the next transform adds them back if the directive is still
    // there.
    watchChange(id) {
      const file = toSlash(id);
      for (const { boundaries } of devClientBoundaries.values()) {
        for (const boundary of boundaries) {
          if (stripViteModuleQuery(boundary) === file) boundaries.delete(boundary);
        }
      }
    },
    transform: {
      // Any module id: plugins may serve JavaScript under virtual or
      // extensionless ids, and code that does not parse is skipped. vinext's
      // own virtual modules only import request APIs in the RSC entry.
      filter: {
        id: { exclude: NODE_MODULES_RE },
        code: CANDIDATE_MODULE_RE,
      },
      async handler(code, id) {
        const environment = this.environment;
        const appDir = options.getAppDir();
        const graphKind = options.worker ? "browser" : getGraphKind(environment, appDir !== null);
        if (!graphKind) return null;
        // A build checks server graphs at buildEnd, against the final graph.
        if (graphKind === "server" && environment.mode !== "dev") return null;
        const tracksBoundaries = tracksClientBoundaries(environment.name, appDir);
        if (
          !SERVER_API_CANDIDATE_RE.test(code) &&
          !(tracksBoundaries && USE_CLIENT_CANDIDATE_RE.test(code))
        ) {
          return null;
        }

        const info = analyzeClientGraphModule(code);
        const invalid = getReportedInvalidImport(info, appDir);
        if (graphKind === "browser") {
          if (invalid) {
            this.error(createInvalidClientImportMessage(invalid.name, id, appDir), invalid.start);
          }
          return null;
        }

        if (environment.mode !== "dev") return null;
        const clientBoundaries = getDevClientBoundaries(environment);
        if (info.isClientBoundary) clientBoundaries.add(id);
        else clientBoundaries.delete(id);
        if (!invalid) return null;
        // In dev the importer that triggered this load is already in the graph.
        const getImporters = (moduleId: string) => {
          const importers: string[] = [];
          for (const importer of environment.moduleGraph.getModuleById(moduleId)?.importers ?? []) {
            if (importer.id) importers.push(importer.id);
          }
          return importers;
        };
        const isClientRoot = await getClientRootPredicate(
          clientBoundaries,
          tracksBoundaries,
          options.isPagesDevEnvironment?.(environment) ?? false,
          (moduleId) => Boolean(environment.moduleGraph.getModuleById(moduleId)),
          (source, importer) => this.resolve(source, importer),
        );
        if (isReachableFromClientRoot(id, isClientRoot, getImporters)) {
          this.error(createInvalidClientImportMessage(invalid.name, id, appDir), invalid.start);
        }
        return null;
      },
    },
    // Analyze the code each module has in this build, so a watch rebuild that
    // reuses cached transforms (or regenerates a virtual module) is checked
    // against current code.
    async buildEnd() {
      const environment = this.environment;
      const appDir = options.getAppDir();
      if (options.worker || getGraphKind(environment, appDir !== null) !== "server") return;
      // Dev checks at transform time; `server.perEnvironmentStartEndDuringDev`
      // also runs buildEnd there, where module code is unavailable.
      if (environment.mode !== "build") return;
      const tracksBoundaries = tracksClientBoundaries(environment.name, appDir);
      const clientBoundaries = new Set<string>();
      const invalidImports = new Map<string, InvalidClientImport>();
      for (const id of this.getModuleIds()) {
        if (NODE_MODULES_RE.test(id)) continue;
        const code = this.getModuleInfo(id)?.code;
        if (!code || !CANDIDATE_MODULE_RE.test(code)) continue;
        const info = analyzeClientGraphModule(code);
        if (info.isClientBoundary) clientBoundaries.add(id);
        const invalid = getReportedInvalidImport(info, appDir);
        if (invalid) invalidImports.set(id, invalid);
      }
      if (invalidImports.size === 0) return;
      const getImporters = (moduleId: string) => {
        const info = this.getModuleInfo(moduleId);
        return info ? [...info.importers, ...info.dynamicImporters] : [];
      };
      const isClientRoot = await getClientRootPredicate(
        clientBoundaries,
        tracksBoundaries,
        false,
        (moduleId) => Boolean(this.getModuleInfo(moduleId)),
        (source, importer) => this.resolve(source, importer),
      );
      for (const [id, invalid] of invalidImports) {
        if (isReachableFromClientRoot(id, isClientRoot, getImporters)) {
          this.error({ id, message: createInvalidClientImportMessage(invalid.name, id, appDir) });
        }
      }
    },
  };
}
