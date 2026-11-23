import fs from "node:fs";
import type { RscPluginManager } from "@vitejs/plugin-rsc";
import path from "pathslash";
import type { DevEnvironment, Plugin, ResolvedConfig, ViteDevServer } from "vite";
import type { AppRoute } from "../routing/app-route-graph.js";
import { safeJsonStringify } from "../server/html.js";
import { rewriteOutputRootExternals } from "../build/output-root-externals.js";
import {
  buildFontOwnerManifest,
  fontInterceptFiles,
  fontOwnerKey,
  fontRouteFiles,
  snapshotModuleGraph,
  type FontOwnerManifest,
  type ModuleGraphSnapshot,
} from "../build/font-owner-manifest.js";

/**
 * The route font manifest of a build: an external import of a file written
 * beside the RSC entry once every environment is built.
 */
export const FONT_OWNER_MANIFEST_ID = "virtual:vinext-font-owner-manifest";
/**
 * Dev: `virtual:vinext-font-owners?route=<pattern>` (or `?routeless`, or
 * `?global-not-found`) exports the owner keys of one render, read from the dev
 * module graphs, as {@link DevFontOwners}.
 */
export const DEV_FONT_OWNERS_ID = "virtual:vinext-font-owners";

const RESOLVED_FONT_OWNER_MANIFEST_ID = `\0${FONT_OWNER_MANIFEST_ID}`;
const RESOLVED_DEV_FONT_OWNERS_PREFIX = `\0${DEV_FONT_OWNERS_ID}?`;
const FONT_OWNER_MANIFEST_FILE = "__vinext_font_owner_manifest.js";
const FONT_OWNER_MANIFEST_EXTERNALS: ReadonlyMap<string, string> = new Map([
  [FONT_OWNER_MANIFEST_ID, FONT_OWNER_MANIFEST_FILE],
]);
const ROUTELESS = "\0routeless";
const GLOBAL_NOT_FOUND = "\0global-not-found";
/** A render's files, and each intercepting route's it renders, by interception ID. */
type RenderFiles = { files: string[]; interceptFiles: Map<string, string[]> };

type RscBuildGraph = {
  graph: ModuleGraphSnapshot;
  /** Client reference module ids with the id the SSR graph imports them by. */
  clientReferenceImportIds: Map<string, string>;
  routes: Map<string, RenderFiles>;
  routelessFiles: string[];
  globalNotFoundFiles: string[];
};

/** A dev render's owner keys: its documents', and its RSC payload's as in `navigation`. */
type DevFontOwners = {
  document: string[];
  route: string[];
  intercepts: Record<string, string[]>;
};

const EMPTY_MANIFEST: FontOwnerManifest = {
  routes: {},
  routeless: [],
  globalNotFound: [],
  navigation: {},
};

export function createFontOwnerManifestPlugin(options: {
  canonicalizeModuleId: (id: string) => string;
  getManager: (config: ResolvedConfig) => Promise<RscPluginManager | undefined>;
  getRoutes: () => readonly AppRoute[] | null;
  /** Files any route's render may show (global-error, the root boundaries). */
  getAlwaysRenderedFiles: () => readonly string[];
  /** Files a render without a matched route shows. */
  getRoutelessFiles: () => readonly string[];
  /**
   * Files the standalone global-not-found render shows: global-not-found, when
   * the app has one, and global-error.
   */
  getGlobalNotFoundFiles: () => readonly string[];
  /** Keys of the modules the `vinext:font-owner` transform marked. */
  ownerKeys: ReadonlySet<string>;
}): Plugin {
  let config: ResolvedConfig;
  let server: ViteDevServer | undefined;
  // "no-owners" when no module had loaded a font by the RSC build, scans
  // included, which spares most apps the graph snapshots.
  let rscBuild: RscBuildGraph | "no-owners" | null = null;
  let ssrBuild: { graph: ModuleGraphSnapshot; clientReferences: Map<string, string> } | null = null;
  const rscOutputDirs = new Set<string>();

  const isOwner = (id: string) => options.ownerKeys.has(fontOwnerKey(config.root, id));

  // Each render's files: a route's own files, or a route-miss render's, plus
  // the files that can show in either, and the intercepting routes' files. The
  // standalone global-not-found render shows no root layout or root boundary,
  // so it is a render of its own.
  const renderFiles = (): Map<string, RenderFiles> => {
    const always = options.getAlwaysRenderedFiles();
    const globalNotFound = options.getGlobalNotFoundFiles();
    const files = new Map<string, RenderFiles>();
    for (const route of options.getRoutes() ?? []) {
      files.set(route.pattern, {
        files: [...fontRouteFiles(route), ...always],
        interceptFiles: fontInterceptFiles(route),
      });
    }
    files.set(ROUTELESS, {
      files: [
        ...options.getRoutelessFiles().filter((file) => !globalNotFound.includes(file)),
        ...always,
      ],
      interceptFiles: new Map(),
    });
    files.set(GLOBAL_NOT_FOUND, { files: [...globalNotFound], interceptFiles: new Map() });
    return files;
  };

  const resolveManifest = (): FontOwnerManifest | null => {
    if (rscBuild === null) return EMPTY_MANIFEST;
    if (rscBuild === "no-owners") {
      // A font owner first seen after the RSC build has no graph to place it
      // in, so that build carries every font, as before fonts were scoped.
      return options.ownerKeys.size === 0 ? EMPTY_MANIFEST : null;
    }
    return buildFontOwnerManifest({
      rsc: rscBuild.graph,
      ssr: ssrBuild?.graph ?? new Map(),
      clientReferences: ssrBuild?.clientReferences ?? new Map(),
      isOwner,
      ownerKey: (id) => fontOwnerKey(config.root, id),
      routes: rscBuild.routes,
      routelessFiles: rscBuild.routelessFiles,
      globalNotFoundFiles: rscBuild.globalNotFoundFiles,
    });
  };

  return {
    name: "vinext:font-owner-manifest",
    configResolved(resolvedConfig) {
      config = resolvedConfig;
    },
    configureServer(devServer) {
      server = devServer;
      // A new or removed file can change a route's files. vinext reloads the
      // RSC environment when the routes change; recompute each render's
      // owners then. Edits to files a walk read invalidate it on their own.
      const invalidate = () => {
        const graph = devServer.environments.rsc?.moduleGraph;
        if (!graph) return;
        for (const [id, module] of graph.idToModuleMap) {
          if (id.startsWith(RESOLVED_DEV_FONT_OWNERS_PREFIX)) graph.invalidateModule(module);
        }
      };
      devServer.watcher.on("add", invalidate);
      devServer.watcher.on("unlink", invalidate);
    },
    resolveId(source) {
      if (source === FONT_OWNER_MANIFEST_ID) {
        return this.environment.mode === "build"
          ? { id: source, external: true }
          : RESOLVED_FONT_OWNER_MANIFEST_ID;
      }
      if (source.startsWith(`${DEV_FONT_OWNERS_ID}?`)) return `\0${source}`;
    },
    async load(id) {
      if (id === RESOLVED_FONT_OWNER_MANIFEST_ID) return "export default null";
      if (!id.startsWith(RESOLVED_DEV_FONT_OWNERS_PREFIX) || !server) return;
      const query = new URLSearchParams(id.slice(RESOLVED_DEV_FONT_OWNERS_PREFIX.length));
      const pattern = query.has("routeless")
        ? ROUTELESS
        : query.has("global-not-found")
          ? GLOBAL_NOT_FOUND
          : query.get("route");
      const files = pattern === null ? undefined : renderFiles().get(pattern);
      const manager = await options.getManager(config);
      const rsc = server.environments.rsc as DevEnvironment | undefined;
      const ssr = server.environments.ssr as DevEnvironment | undefined;
      // Unknown route or environments: every font, as before fonts were scoped.
      if (!files || !manager || !rsc || !ssr) return "export default null";

      // Editing any module a walk read can change the render's fonts.
      const watch = (file: string | null) => {
        if (file) this.addWatchFile(file);
      };
      const ownersOf = async (roots: readonly string[]) => {
        const serverOwners = new Set<string>();
        const clientOwners = new Set<string>();
        const clientReferences: string[] = [];
        await walkDevModuleGraph(rsc, roots.map(options.canonicalizeModuleId), (id, file) => {
          watch(file);
          if (manager.clientReferenceMetaMap[id]) {
            clientReferences.push(id);
            return false;
          }
          if (isOwner(id)) serverOwners.add(fontOwnerKey(config.root, id));
          return true;
        });
        await walkDevModuleGraph(ssr, clientReferences, (id, file) => {
          watch(file);
          if (isOwner(id)) clientOwners.add(fontOwnerKey(config.root, id));
          return true;
        });
        return { server: [...serverOwners].sort(), client: [...clientOwners] };
      };
      const own = await ownersOf(files.files);
      const intercepts: Record<string, string[]> = {};
      for (const [interceptionId, interceptFiles] of files.interceptFiles) {
        intercepts[interceptionId] = (await ownersOf(interceptFiles)).server;
      }
      const owners: DevFontOwners = {
        document: [...new Set([...own.server, ...own.client])].sort(),
        route: own.server,
        intercepts,
      };
      return `export default ${JSON.stringify(owners)};`;
    },
    outputOptions(output) {
      if (this.environment.name === "rsc" && output.dir) {
        rscOutputDirs.add(output.dir);
      }
    },
    async generateBundle() {
      const manager = await options.getManager(config);
      if (!manager) {
        throw new Error("vinext: failed to access @vitejs/plugin-rsc through getPluginApi().");
      }
      if (manager.isScanBuild) return;

      if (this.environment.name === "rsc") {
        if (options.ownerKeys.size === 0) {
          rscBuild = "no-owners";
          return;
        }
        const graph = snapshotModuleGraph(this.getModuleIds(), (id) => this.getModuleInfo(id));
        const clientReferenceImportIds = new Map<string, string>();
        for (const id of graph.keys()) {
          const reference = manager.clientReferenceMetaMap[id];
          if (reference) clientReferenceImportIds.set(id, reference.importId);
        }
        const routes = new Map(
          [...renderFiles()].map(([render, { files, interceptFiles }]) => [
            render,
            {
              files: files.map(options.canonicalizeModuleId),
              interceptFiles: new Map(
                [...interceptFiles].map(([interceptionId, files]) => [
                  interceptionId,
                  files.map(options.canonicalizeModuleId),
                ]),
              ),
            },
          ]),
        );
        const routelessFiles = routes.get(ROUTELESS)?.files ?? [];
        const globalNotFoundFiles = routes.get(GLOBAL_NOT_FOUND)?.files ?? [];
        routes.delete(ROUTELESS);
        routes.delete(GLOBAL_NOT_FOUND);
        rscBuild = { graph, clientReferenceImportIds, routes, routelessFiles, globalNotFoundFiles };
      } else if (this.environment.name === "ssr" && rscBuild && rscBuild !== "no-owners") {
        // Client references render in the SSR graph, where their fonts load.
        const clientReferences = new Map<string, string>();
        const resolvedImportIds = new Map<string, string>();
        for (const [id, importId] of rscBuild.clientReferenceImportIds) {
          let resolved = resolvedImportIds.get(importId);
          if (resolved === undefined) {
            resolved = options.canonicalizeModuleId((await this.resolve(importId))?.id ?? importId);
            resolvedImportIds.set(importId, resolved);
          }
          clientReferences.set(id, resolved);
        }
        ssrBuild = {
          graph: snapshotModuleGraph(this.getModuleIds(), (id) => this.getModuleInfo(id)),
          clientReferences,
        };
      }
    },
    renderChunk(code, chunk) {
      return rewriteOutputRootExternals(code, chunk.fileName, FONT_OWNER_MANIFEST_EXTERNALS);
    },
    buildApp: {
      order: "post",
      async handler(builder) {
        if (rscOutputDirs.size === 0) {
          rscOutputDirs.add(builder.config.environments.rsc.build.outDir);
        }
        const manifest = resolveManifest();
        await Promise.all(
          [...rscOutputDirs].map(async (outDir) => {
            await fs.promises.mkdir(outDir, { recursive: true });
            await fs.promises.writeFile(
              path.join(outDir, FONT_OWNER_MANIFEST_FILE),
              `export default ${safeJsonStringify(manifest)};\n`,
            );
          }),
        );
        rscBuild = null;
        ssrBuild = null;
        rscOutputDirs.clear();
      },
    },
  };
}

/**
 * Walk a dev module graph from `roots` through static and dynamic imports.
 * The graph only knows the modules requests have loaded so far, so a module it
 * has not transformed yet is transformed here, as its request would. Packages
 * are walked only once loaded: dev externalizes or prebundles them, and the
 * font transform never sees those copies. `visit` returns whether to walk on
 * through a module's imports. With `transformMissing` false, it reads only the
 * graph as it is.
 */
async function walkDevModuleGraph(
  environment: DevEnvironment,
  roots: readonly string[],
  visit: (id: string, file: string | null) => boolean,
  transformMissing = true,
): Promise<void> {
  const visited = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (visited.has(id) || id.startsWith("\0")) continue;
    visited.add(id);
    let module = environment.moduleGraph.getModuleById(id);
    if (transformMissing && !module?.transformResult && !id.includes("/node_modules/")) {
      try {
        await environment.transformRequest(module?.url ?? id);
      } catch {
        // The request for it will report the error.
      }
      module = environment.moduleGraph.getModuleById(id);
    }
    if (!module) continue;
    if (!visit(id, module.file)) continue;
    for (const imported of module.importedModules) {
      if (imported.id) stack.push(imported.id);
    }
  }
}

/**
 * The Pages Router font manifest: an external import of a file the Pages
 * server build writes beside its entry, mapping each page's route pattern to
 * the owners its document carries.
 */
export const PAGES_FONT_OWNER_MANIFEST_ID = "virtual:vinext-pages-font-owner-manifest";
/** Dev: `virtual:vinext-pages-font-owners?page=<pattern>` exports a page's owner keys. */
export const DEV_PAGES_FONT_OWNERS_ID = "virtual:vinext-pages-font-owners";

const RESOLVED_PAGES_FONT_OWNER_MANIFEST_ID = `\0${PAGES_FONT_OWNER_MANIFEST_ID}`;
const RESOLVED_DEV_PAGES_FONT_OWNERS_PREFIX = `\0${DEV_PAGES_FONT_OWNERS_ID}?`;
const PAGES_FONT_OWNER_MANIFEST_FILE = "__vinext_pages_font_owner_manifest.js";
const PAGES_FONT_OWNER_MANIFEST_EXTERNALS: ReadonlyMap<string, string> = new Map([
  [PAGES_FONT_OWNER_MANIFEST_ID, PAGES_FONT_OWNER_MANIFEST_FILE],
]);

/** The files whose fonts a page's document carries: `_app`'s and the page's. */
type PagesFontRoutes = { appFile: string | null; pages: { pattern: string; filePath: string }[] };

/**
 * The owner keys of a dev Pages render: the font owners the server graph of
 * `files` reaches. Next.js gives a page the fonts of `_app` and of the page.
 * A Pages render reads them after it has run the page, so the graph already
 * holds its imports: an invalidated module keeps them. Transforming it here
 * would race the module runner's own reload after an edit.
 */
export async function collectDevPagesFontOwners(
  environment: DevEnvironment,
  files: readonly (string | null | undefined)[],
  options: {
    canonicalizeModuleId: (id: string) => string;
    isOwner: (id: string) => boolean;
    ownerKey: (id: string) => string;
    watch?: (file: string) => void;
  },
): Promise<string[]> {
  const owners = new Set<string>();
  const roots = files.filter((file): file is string => typeof file === "string");
  await walkDevModuleGraph(
    environment,
    roots.map(options.canonicalizeModuleId),
    (id, file) => {
      if (file) options.watch?.(file);
      if (options.isOwner(id)) owners.add(options.ownerKey(id));
      return true;
    },
    false,
  );
  return [...owners].sort();
}

export function createPagesFontOwnerManifestPlugin(options: {
  canonicalizeModuleId: (id: string) => string;
  getRoutes: () => Promise<PagesFontRoutes>;
  /** Keys of the modules the `vinext:font-owner` transform marked. */
  ownerKeys: ReadonlySet<string>;
}): Plugin {
  let root = "";
  const isOwner = (id: string) => options.ownerKeys.has(fontOwnerKey(root, id));
  const ownerKey = (id: string) => fontOwnerKey(root, id);

  return {
    name: "vinext:pages-font-owner-manifest",
    configResolved(config) {
      root = config.root;
    },
    resolveId(source) {
      if (source === PAGES_FONT_OWNER_MANIFEST_ID) {
        return this.environment.mode === "build"
          ? { id: source, external: true }
          : RESOLVED_PAGES_FONT_OWNER_MANIFEST_ID;
      }
      if (source.startsWith(`${DEV_PAGES_FONT_OWNERS_ID}?`)) return `\0${source}`;
    },
    async load(id) {
      if (id === RESOLVED_PAGES_FONT_OWNER_MANIFEST_ID) return "export default null";
      if (!id.startsWith(RESOLVED_DEV_PAGES_FONT_OWNERS_PREFIX)) return;
      const pattern = new URLSearchParams(
        id.slice(RESOLVED_DEV_PAGES_FONT_OWNERS_PREFIX.length),
      ).get("page");
      const { appFile, pages } = await options.getRoutes();
      const page = pages.find((candidate) => candidate.pattern === pattern);
      const environment = this.environment as DevEnvironment;
      // Unknown page: every font, as before fonts were scoped.
      if (!page || typeof environment.transformRequest !== "function") {
        return "export default null";
      }
      const owners = await collectDevPagesFontOwners(environment, [appFile, page.filePath], {
        canonicalizeModuleId: options.canonicalizeModuleId,
        isOwner,
        ownerKey,
        // Editing any module the walk read can change the page's fonts.
        watch: (file) => this.addWatchFile(file),
      });
      return `export default ${JSON.stringify(owners)};`;
    },
    renderChunk(code, chunk) {
      return rewriteOutputRootExternals(code, chunk.fileName, PAGES_FONT_OWNER_MANIFEST_EXTERNALS);
    },
    async generateBundle() {
      // Only the server build whose entry reads the manifest writes it.
      if (this.environment.config.consumer !== "server") return;
      if (!this.getModuleInfo(PAGES_FONT_OWNER_MANIFEST_ID)) return;
      const { appFile, pages } = await options.getRoutes();
      let manifest: Pick<FontOwnerManifest, "routes"> = { routes: {} };
      if (options.ownerKeys.size > 0) {
        const app = appFile ? [options.canonicalizeModuleId(appFile)] : [];
        manifest = buildFontOwnerManifest({
          rsc: snapshotModuleGraph(this.getModuleIds(), (id) => this.getModuleInfo(id)),
          ssr: new Map(),
          clientReferences: new Map(),
          isOwner,
          ownerKey,
          routes: new Map(
            pages.map(({ pattern, filePath }) => [
              pattern,
              {
                files: [...app, options.canonicalizeModuleId(filePath)],
                interceptFiles: new Map(),
              },
            ]),
          ),
          routelessFiles: [],
          globalNotFoundFiles: [],
        });
      }
      this.emitFile({
        type: "asset",
        fileName: PAGES_FONT_OWNER_MANIFEST_FILE,
        source: `export default ${safeJsonStringify({ routes: manifest.routes })};\n`,
      });
    },
  };
}
