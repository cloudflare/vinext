import fs from "node:fs";
import type { RscPluginManager } from "@vitejs/plugin-rsc";
import path from "pathslash";
import type { Plugin, ResolvedConfig, Rollup } from "vite";
import type { AppRoute } from "../routing/app-route-graph.js";
import { safeJsonStringify } from "../server/html.js";
import { rewriteOutputRootExternals } from "../build/output-root-externals.js";
import {
  addClientActionReachability,
  buildActionOwnerManifest,
  collectRscActionReachability,
  resolveClientReferenceImportIds,
  type ActionOwnerRouteReachability,
} from "../build/action-owner-manifest.js";

export const ACTION_OWNER_MANIFEST_ID = "virtual:vinext-action-owner-manifest";

const RESOLVED_ACTION_OWNER_MANIFEST_ID = `\0${ACTION_OWNER_MANIFEST_ID}`;
// `.mjs` so Node treats the generated ESM as ESM when the app root is
// `"type": "commonjs"` (Next.js vercel/next.js#101164).
const ACTION_OWNER_MANIFEST_FILE = "__vinext_action_owner_manifest.mjs";
const ACTION_OWNER_MANIFEST_EXTERNALS: ReadonlyMap<string, string> = new Map([
  [ACTION_OWNER_MANIFEST_ID, ACTION_OWNER_MANIFEST_FILE],
]);

/**
 * Vite emits `index.mjs` when the app root is `"type": "commonjs"`, but
 * plugin-rsc hardcodes `loadModule("ssr", "index")` → `index.js` and leftover
 * sidecars stay `.js`. A nested `"type": "module"` plus an `index.js` re-export
 * keeps those files ESM (Next.js vercel/next.js#101164).
 */
async function ensureEsmJsFacade(outDir: string): Promise<void> {
  const mjsEntry = path.join(outDir, "index.mjs");
  const jsEntry = path.join(outDir, "index.js");
  if (!fs.existsSync(mjsEntry)) return;
  await fs.promises.mkdir(outDir, { recursive: true });
  if (!fs.existsSync(jsEntry)) {
    await fs.promises.writeFile(
      jsEntry,
      `export { default } from "./index.mjs";\nexport * from "./index.mjs";\n`,
    );
  }
  await fs.promises.writeFile(path.join(outDir, "package.json"), `{ "type": "module" }\n`);
}

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
      return rewriteOutputRootExternals(code, chunk.fileName, ACTION_OWNER_MANIFEST_EXTERNALS);
    },
    buildApp: {
      order: "post",
      async handler(builder) {
        if (rscOutputDirs.size === 0) {
          rscOutputDirs.add(builder.config.environments.rsc.build.outDir);
        }
        const root = builder.config.root;
        const ssrOutDir = builder.config.environments.ssr?.build.outDir;
        await Promise.all([
          ...[...rscOutputDirs].map(async (outDir) => {
            await fs.promises.mkdir(outDir, { recursive: true });
            await fs.promises.writeFile(
              path.join(outDir, ACTION_OWNER_MANIFEST_FILE),
              `export default ${safeJsonStringify(manifest)};\n`,
            );
            await ensureEsmJsFacade(outDir);
          }),
          ssrOutDir ? ensureEsmJsFacade(path.resolve(root, ssrOutDir)) : Promise.resolve(),
        ]);
        routeReachability = new Map();
        manifest = {};
        rscOutputDirs.clear();
        options.onComplete?.();
      },
    },
  };
}
