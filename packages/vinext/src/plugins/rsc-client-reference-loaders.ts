import { isCSSRequest, type Plugin, type Rollup } from "vite";
import type { PluginApi } from "@vitejs/plugin-rsc";
import {
  CLIENT_REFERENCE_GROUP_MAX_COST_BYTES,
  collectClientReferenceRouteSignatures,
  measureClientReferenceGroupCosts,
  planClientReferenceGroups,
} from "../build/client-reference-groups.js";
import { hasUserClientChunkGroups } from "../build/client-build-config.js";
import type { AppRoute } from "../routing/app-route-graph.js";

const CLIENT_REFERENCES_ID = "\0virtual:vite-rsc/client-references";
const RESOLVED_ID_PROXY_PREFIX = "virtual:vite-rsc/resolved-id/";
const CLIENT_REFERENCE_GROUP_PREFIX = "virtual:vinext-client-reference-group-";
const RESOLVED_CLIENT_REFERENCE_GROUP_PREFIX = `\0${CLIENT_REFERENCE_GROUP_PREFIX}`;

type RscClientReferenceMeta = PluginApi["manager"]["clientReferenceMetaMap"][string];

type RscPluginWithApi = Plugin & {
  api?: PluginApi;
};

export type RscClientReferenceGroupingOptions = {
  /** Maps route file paths to the module ids used by the RSC module graph. */
  canonicalizeModuleId: (id: string) => string;
  /** App Router routes of the current build, or null outside App Router builds. */
  getRoutes: () => readonly AppRoute[] | null;
  /** Route-independent roots such as global-error and global-not-found. */
  getSharedRoots: () => readonly string[];
  /** Modules that live in chunks every page loads anyway (React, vinext runtime). */
  isAlwaysLoadedClientModule: (id: string) => boolean;
  /** vinext's own client chunk groups. Any other chunk group disables grouping. */
  ownClientChunkGroups: ReadonlySet<unknown>;
};

function withResolvedIdProxy(resolvedId: string): string {
  return resolvedId.startsWith("\0")
    ? RESOLVED_ID_PROXY_PREFIX + encodeURIComponent(resolvedId)
    : resolvedId;
}

type ClientReferenceGroupSlot = { groupId: string; index: number };

function sortedRenderedExports(meta: RscClientReferenceMeta): string[] {
  return meta.renderedExports.slice().sort();
}

function groupExportName(slotIndex: number, exportIndex: number): string {
  return `r${slotIndex}_${exportIndex}`;
}

function generateClientReferenceObject(
  meta: RscClientReferenceMeta,
  slot: ClientReferenceGroupSlot | undefined,
): string {
  // Keep exports lazy. In async or cyclic client module evaluation, eagerly
  // copying module namespace values can observe an uninitialized binding.
  const exports = sortedRenderedExports(meta)
    .map((name, exportIndex) => {
      const value = slot
        ? `m.${groupExportName(slot.index, exportIndex)}`
        : `m[${JSON.stringify(name)}]`;
      return `      get ${JSON.stringify(name)}() { return ${value}; },`;
    })
    .join("\n");

  return exports ? `{\n${exports}\n    }` : "{}";
}

function generateClientReferenceLoaders(
  metas: RscClientReferenceMeta[],
  slots: ReadonlyMap<RscClientReferenceMeta, ClientReferenceGroupSlot> = new Map(),
): string {
  const entries = metas
    .slice()
    .sort((a, b) => a.referenceKey.localeCompare(b.referenceKey))
    .map((meta) => {
      const slot = slots.get(meta);
      const source = slot ? slot.groupId : withResolvedIdProxy(meta.importId);
      return [
        `  ${JSON.stringify(meta.referenceKey)}: async () => {`,
        `    const m = await import(${JSON.stringify(source)});`,
        `    return ${generateClientReferenceObject(meta, slot)};`,
        `  },`,
      ].join("\n");
    })
    .join("\n");

  return `export default {\n${entries}\n};\n`;
}

/**
 * Re-export only each member's rendered exports, as live bindings, so unused
 * exports and their dependencies still tree-shake as they do with direct
 * loaders. A member without rendered exports is imported for its side effects.
 */
function generateClientReferenceGroupModule(metas: readonly RscClientReferenceMeta[]): string {
  const lines = metas.map((meta, slotIndex) => {
    const source = JSON.stringify(withResolvedIdProxy(meta.importId));
    const specifiers = sortedRenderedExports(meta).map((name, exportIndex) => {
      const imported = /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
      return `${imported} as ${groupExportName(slotIndex, exportIndex)}`;
    });
    return specifiers.length > 0
      ? `export { ${specifiers.join(", ")} } from ${source};`
      : `import ${source};`;
  });
  return `${lines.join("\n")}\n`;
}

/**
 * Replaces @vitejs/plugin-rsc's client-reference facades with per-reference
 * loaders. With `grouping`, production client builds additionally load
 * references that the same App Router routes reach through one shared route
 * group module (see build/client-reference-groups.ts), so a page fetches one
 * chunk per route group instead of one per `"use client"` module.
 */
export function createRscClientReferenceLoadersPlugin(
  grouping?: RscClientReferenceGroupingOptions,
): Plugin {
  let rscApi: PluginApi | undefined;
  let root = "";
  let groupingEnabled = false;
  // Client reference id -> signature of the routes that reach it, collected
  // from the RSC graph, which @vitejs/plugin-rsc builds before the client.
  let routeSignatures = new Map<string, string>();
  const groupModules = new Map<string, string>();

  return {
    name: "vinext:rsc-client-reference-loaders",
    enforce: "post",
    configResolved(config) {
      root = config.root;
      rscApi = (
        config.plugins.find((plugin) => plugin.name === "rsc:minimal") as
          | RscPluginWithApi
          | undefined
      )?.api;
    },
    outputOptions: {
      // Rolldown resolves output options before the build starts, so this sees
      // the client output after every other plugin's config and outputOptions
      // hooks (this one runs last), before any group is planned.
      order: "post",
      handler(output) {
        if (this.environment?.name !== "client") return;
        groupingEnabled =
          !!grouping && !hasUserClientChunkGroups(output, grouping.ownClientChunkGroups);
      },
    },
    buildStart() {
      if (this.environment.name === "rsc") routeSignatures = new Map();
      if (this.environment.name === "client") groupModules.clear();
    },
    buildEnd(error) {
      if (error || !grouping) return;
      if (this.environment.name !== "rsc" || this.environment.mode !== "build") return;
      const manager = rscApi?.manager;
      const routes = grouping.getRoutes();
      if (!manager || manager.isScanBuild || !routes) return;

      routeSignatures = collectClientReferenceRouteSignatures({
        canonicalizeModuleId: grouping.canonicalizeModuleId,
        clientReferenceIds: new Set(Object.keys(manager.clientReferenceMetaMap)),
        getModuleInfo: (id) => this.getModuleInfo(id),
        root,
        routes,
        sharedRoots: grouping.getSharedRoots(),
      });
    },
    resolveId(source) {
      if (source.startsWith(CLIENT_REFERENCE_GROUP_PREFIX) && groupModules.has(`\0${source}`)) {
        return `\0${source}`;
      }
      return null;
    },
    load(id) {
      return groupModules.get(id) ?? null;
    },
    async transform(_code, id) {
      if (id !== CLIENT_REFERENCES_ID) return null;

      const manager = rscApi?.manager;
      if (!manager || manager.isScanBuild) return null;

      // This post-transform runs after @vitejs/plugin-rsc has loaded the
      // client-reference virtual module and populated the manager metadata. The
      // clientChunks option can change facade grouping, but it still emits
      // facades; this replaces the generated facade with direct loaders while
      // preserving the manifest fields the RSC plugin writes later in the build.
      const metaEntries = Object.entries(manager.clientReferenceMetaMap).filter(
        ([, meta]) => meta.serverChunk,
      );
      const metas = metaEntries.map(([, meta]) => meta);
      if (metas.length === 0) return null;

      for (const [id, meta] of metaEntries) {
        // The RSC assets manifest indexes deps by Rollup/Rolldown module ids
        // from chunk.moduleIds. Keep the resolved map key here; meta.importId
        // can be a bare package specifier for node_modules client references.
        meta.groupChunkId = id;
      }

      const slots = new Map<RscClientReferenceMeta, ClientReferenceGroupSlot>();
      const referenceIds = new Set(metaEntries.map(([referenceId]) => referenceId));
      if (
        grouping &&
        groupingEnabled &&
        this.environment.name === "client" &&
        this.environment.mode === "build" &&
        // Skip measuring when no two references share a signature.
        planClientReferenceGroups({
          referenceIds,
          signatures: routeSignatures,
          costs: new Map([...referenceIds].map((referenceId) => [referenceId, 0])),
          maxCostBytes: 0,
        }).length > 0
      ) {
        // Reference ids come from the RSC graph; resolve each import id in this
        // environment so packages are measured through their browser entry.
        const references = new Map<string, string>();
        const resolvedReferences = new Map<string, Rollup.ResolvedId>();
        await Promise.all(
          metaEntries.map(async ([referenceId, meta]) => {
            if (meta.importId.startsWith("\0")) {
              references.set(referenceId, meta.importId);
              return;
            }
            const resolved = await this.resolve(meta.importId);
            if (!resolved || resolved.external) return;
            references.set(referenceId, resolved.id);
            resolvedReferences.set(resolved.id, resolved);
          }),
        );
        // Measure every reference, not just grouping candidates, so code shared
        // with an ungroupable reference still counts as shared.
        const costs = await measureClientReferenceGroupCosts({
          references,
          loadModule: async (moduleId) => {
            // Pass the full resolution so package metadata such as
            // `sideEffects` is kept for modules this loads first.
            const info = await this.load(resolvedReferences.get(moduleId) ?? { id: moduleId });
            return { code: info.code, importedIds: info.importedIds };
          },
          isExcluded: (moduleId) =>
            moduleId === CLIENT_REFERENCES_ID ||
            moduleId.startsWith(RESOLVED_CLIENT_REFERENCE_GROUP_PREFIX) ||
            isCSSRequest(moduleId) ||
            grouping.isAlwaysLoadedClientModule(moduleId),
        });
        const groups = planClientReferenceGroups({
          referenceIds,
          signatures: routeSignatures,
          costs,
          maxCostBytes: CLIENT_REFERENCE_GROUP_MAX_COST_BYTES,
        });
        const metaById = new Map(metaEntries);
        for (const group of groups) {
          const groupMetas = group.referenceIds.map((referenceId) => metaById.get(referenceId)!);
          const resolvedGroupId = `${RESOLVED_CLIENT_REFERENCE_GROUP_PREFIX}${group.key}`;
          groupModules.set(resolvedGroupId, generateClientReferenceGroupModule(groupMetas));
          groupMetas.forEach((meta, index) => {
            // Asset deps for every member come from the shared group chunk.
            meta.groupChunkId = resolvedGroupId;
            slots.set(meta, { groupId: resolvedGroupId.slice(1), index });
          });
        }
      }

      return {
        code: generateClientReferenceLoaders(metas, slots),
        map: null,
      };
    },
  };
}
