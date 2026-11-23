import fs from "node:fs";
import type { RscPluginManager } from "@vitejs/plugin-rsc";
import path from "pathslash";
import type { DevEnvironment, Plugin, ResolvedConfig, ViteDevServer } from "vite";
import type { AppRoute } from "../routing/app-route-graph.js";
import { safeJsonStringify } from "../server/html.js";
import { rewriteOutputRootExternals } from "../build/output-root-externals.js";
import {
  buildFontOwnerManifest,
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
 * Dev: `virtual:vinext-font-owners?route=<pattern>` (or `?routeless`) exports
 * the owner keys of one render, read from the dev module graphs.
 */
export const DEV_FONT_OWNERS_ID = "virtual:vinext-font-owners";

const RESOLVED_FONT_OWNER_MANIFEST_ID = `\0${FONT_OWNER_MANIFEST_ID}`;
const RESOLVED_DEV_FONT_OWNERS_PREFIX = `\0${DEV_FONT_OWNERS_ID}?`;
const FONT_OWNER_MANIFEST_FILE = "__vinext_font_owner_manifest.js";
const FONT_OWNER_MANIFEST_EXTERNALS: ReadonlyMap<string, string> = new Map([
  [FONT_OWNER_MANIFEST_ID, FONT_OWNER_MANIFEST_FILE],
]);
const ROUTELESS = "\0routeless";

type RscBuildGraph = {
  graph: ModuleGraphSnapshot;
  /** Client reference module ids with the id the SSR graph imports them by. */
  clientReferenceImportIds: Map<string, string>;
  routes: Map<string, string[]>;
  routelessFiles: string[];
};

export function createFontOwnerManifestPlugin(options: {
  canonicalizeModuleId: (id: string) => string;
  getManager: (config: ResolvedConfig) => Promise<RscPluginManager | undefined>;
  getRoutes: () => readonly AppRoute[] | null;
  /** Files any route's render may show (global-error, the root boundaries). */
  getAlwaysRenderedFiles: () => readonly string[];
  /** Files a render without a matched route shows. */
  getRoutelessFiles: () => readonly string[];
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
  // the files that can show in either.
  const renderFiles = (): Map<string, string[]> => {
    const always = options.getAlwaysRenderedFiles();
    const files = new Map<string, string[]>();
    for (const route of options.getRoutes() ?? []) {
      files.set(route.pattern, [...fontRouteFiles(route), ...always]);
    }
    files.set(ROUTELESS, [...options.getRoutelessFiles(), ...always]);
    return files;
  };

  const resolveManifest = (): FontOwnerManifest | null => {
    if (rscBuild === null) return { routes: {}, routeless: [] };
    if (rscBuild === "no-owners") {
      // A font owner first seen after the RSC build has no graph to place it
      // in, so that build carries every font, as before fonts were scoped.
      return options.ownerKeys.size === 0 ? { routes: {}, routeless: [] } : null;
    }
    return buildFontOwnerManifest({
      rsc: rscBuild.graph,
      ssr: ssrBuild?.graph ?? new Map(),
      clientReferences: ssrBuild?.clientReferences ?? new Map(),
      isOwner,
      ownerKey: (id) => fontOwnerKey(config.root, id),
      routes: rscBuild.routes,
      routelessFiles: rscBuild.routelessFiles,
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
      const pattern = query.has("routeless") ? ROUTELESS : query.get("route");
      const files = pattern === null ? undefined : renderFiles().get(pattern);
      const manager = await options.getManager(config);
      const rsc = server.environments.rsc as DevEnvironment | undefined;
      const ssr = server.environments.ssr as DevEnvironment | undefined;
      // Unknown route or environments: every font, as before fonts were scoped.
      if (!files || !manager || !rsc || !ssr) return "export default null";

      const owners = new Set<string>();
      const clientReferences = new Set<string>();
      const visit = (file: string | null | undefined, moduleId: string) => {
        // Editing any module the walk read can change the render's fonts.
        if (file) this.addWatchFile(file);
        if (isOwner(moduleId)) owners.add(fontOwnerKey(config.root, moduleId));
      };
      await walkDevModuleGraph(rsc, files.map(options.canonicalizeModuleId), (id, file) => {
        visit(file, id);
        if (!manager.clientReferenceMetaMap[id]) return true;
        clientReferences.add(id);
        return false;
      });
      await walkDevModuleGraph(ssr, [...clientReferences], (id, file) => {
        visit(file, id);
        return true;
      });
      return `export default ${JSON.stringify([...owners].sort())};`;
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
          [...renderFiles()].map(([render, files]) => [
            render,
            files.map(options.canonicalizeModuleId),
          ]),
        );
        const routelessFiles = routes.get(ROUTELESS) ?? [];
        routes.delete(ROUTELESS);
        rscBuild = { graph, clientReferenceImportIds, routes, routelessFiles };
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
 * through a module's imports.
 */
async function walkDevModuleGraph(
  environment: DevEnvironment,
  roots: readonly string[],
  visit: (id: string, file: string | null) => boolean,
): Promise<void> {
  const visited = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (visited.has(id) || id.startsWith("\0")) continue;
    visited.add(id);
    let module = environment.moduleGraph.getModuleById(id);
    if (!module?.transformResult && !id.includes("/node_modules/")) {
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
