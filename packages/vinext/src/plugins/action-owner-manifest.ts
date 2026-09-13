import fs from "node:fs";
import type { RscPluginManager } from "@vitejs/plugin-rsc";
import path from "pathslash";
import type { Plugin, ResolvedConfig, Rollup } from "vite";
import type { AppRoute } from "../routing/app-route-graph.js";
import { safeJsonStringify } from "../server/html.js";
import {
  addClientActionReachability,
  buildActionOwnerManifest,
  collectRscActionReachability,
  resolveClientReferenceImportIds,
  type ActionOwnerRouteReachability,
} from "../build/action-owner-manifest.js";

export const ACTION_OWNER_MANIFEST_ID = "virtual:vinext-action-owner-manifest";

const RESOLVED_ACTION_OWNER_MANIFEST_ID = `\0${ACTION_OWNER_MANIFEST_ID}`;
const ACTION_OWNER_MANIFEST_FILE = "__vinext_action_owner_manifest.js";

function getModuleInfo(context: Rollup.PluginContext, id: string) {
  const info = context.getModuleInfo(id);
  if (!info) return null;
  return {
    importedIds: info.importedIds,
    dynamicallyImportedIds: info.dynamicallyImportedIds,
  };
}

export function createActionOwnerManifestPlugin(options: {
  canonicalizeModuleId: (id: string) => string;
  getManager: (config: ResolvedConfig) => Promise<RscPluginManager | undefined>;
  getRoutes: () => readonly AppRoute[];
  getSharedRoots: () => readonly string[];
  onComplete?: () => void;
}): Plugin {
  let config: ResolvedConfig;
  let routeReachability: ActionOwnerRouteReachability = new Map();
  let manifest: Record<string, string[]> = {};
  const rscOutputDirs = new Set<string>();

  return {
    name: "vinext:action-owner-manifest",
    configResolved(resolvedConfig) {
      config = resolvedConfig;
    },
    resolveId(source) {
      if (source !== ACTION_OWNER_MANIFEST_ID) return;
      return this.environment.mode === "build"
        ? { id: source, external: true }
        : RESOLVED_ACTION_OWNER_MANIFEST_ID;
    },
    load(id) {
      if (id === RESOLVED_ACTION_OWNER_MANIFEST_ID) return "export default null";
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
        routeReachability = collectRscActionReachability({
          canonicalizeModuleId: options.canonicalizeModuleId,
          clientReferenceMetaMap: manager.clientReferenceMetaMap,
          getModuleInfo: (id) => getModuleInfo(this, id),
          routes: options.getRoutes(),
          serverReferenceMetaMap: manager.serverReferences.metaMap,
          sharedRoots: options.getSharedRoots(),
        });
      } else if (this.environment.name === "client") {
        await resolveClientReferenceImportIds({
          canonicalizeModuleId: options.canonicalizeModuleId,
          resolveId: async (id) => (await this.resolve(id))?.id ?? null,
          routeReachability,
        });
        addClientActionReachability({
          canonicalizeModuleId: options.canonicalizeModuleId,
          clientReferenceMetaMap: manager.clientReferenceMetaMap,
          getModuleInfo: (id) => getModuleInfo(this, id),
          routeReachability,
          serverReferenceMetaMap: manager.serverReferences.metaMap,
        });
        manifest = buildActionOwnerManifest(routeReachability);
      }
    },
    renderChunk(code, chunk) {
      if (!code.includes(ACTION_OWNER_MANIFEST_ID)) return;
      let relativePath = path.posix.relative(
        path.posix.dirname(chunk.fileName),
        ACTION_OWNER_MANIFEST_FILE,
      );
      if (!relativePath.startsWith(".")) relativePath = `./${relativePath}`;
      return { code: code.replaceAll(ACTION_OWNER_MANIFEST_ID, relativePath) };
    },
    buildApp: {
      order: "post",
      async handler(builder) {
        if (rscOutputDirs.size === 0) {
          rscOutputDirs.add(builder.config.environments.rsc.build.outDir);
        }
        await Promise.all(
          [...rscOutputDirs].map(async (outDir) => {
            await fs.promises.mkdir(outDir, { recursive: true });
            await fs.promises.writeFile(
              path.join(outDir, ACTION_OWNER_MANIFEST_FILE),
              `export default ${safeJsonStringify(manifest)};\n`,
            );
          }),
        );
        routeReachability = new Map();
        manifest = {};
        rscOutputDirs.clear();
        options.onComplete?.();
      },
    },
  };
}
