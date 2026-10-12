import type { Plugin } from "vite";
import type { PluginApi } from "@vitejs/plugin-rsc";
import { toSlash } from "pathslash";
import { tryRealpathSync } from "../build/ssr-manifest.js";

const CLIENT_REFERENCES_ID = "\0virtual:vite-rsc/client-references";
const RESOLVED_ID_PROXY_PREFIX = "virtual:vite-rsc/resolved-id/";

type RscClientReferenceMeta = PluginApi["manager"]["clientReferenceMetaMap"][string];

type RscClientReferenceLoadersOptions = {
  /** vinext's preload-hint shim (shims/dynamic-preload-chunks), as a canonical module id. */
  dynamicPreloadChunksShimId: string;
};

// Rolldown keys modules by canonical path: realpath, forward slashes.
function canonicalModuleId(id: string): string {
  return toSlash(tryRealpathSync(id) ?? id);
}

type RscPluginWithApi = Plugin & {
  api?: PluginApi;
};

function withResolvedIdProxy(resolvedId: string): string {
  return resolvedId.startsWith("\0")
    ? RESOLVED_ID_PROXY_PREFIX + encodeURIComponent(resolvedId)
    : resolvedId;
}

function generateClientReferenceObject(meta: RscClientReferenceMeta): string {
  // Keep exports lazy. In async or cyclic client module evaluation, eagerly
  // copying module namespace values can observe an uninitialized binding.
  const exports = meta.renderedExports
    .slice()
    .sort()
    .map((name) => `      get ${JSON.stringify(name)}() { return m[${JSON.stringify(name)}]; },`)
    .join("\n");

  return exports ? `{\n${exports}\n    }` : "{}";
}

/**
 * Reference key of vinext's preload-hint shim, which the SSR entry loads before
 * React can reach a next/dynamic boundary. Matched by module id, so a user
 * module at another `shims/dynamic-preload-chunks` path is never picked.
 */
export function selectDynamicPreloadChunksReferenceKey(
  metaEntries: readonly (readonly [string, { referenceKey: string }])[],
  dynamicPreloadChunksShimId: string,
): string | undefined {
  return metaEntries.find(([id]) => canonicalModuleId(id) === dynamicPreloadChunksShimId)?.[1]
    .referenceKey;
}

function generateDynamicPreloadChunksReferenceKey(key: string | undefined): string {
  return `export const dynamicPreloadChunksReferenceKey = ${key === undefined ? "undefined" : JSON.stringify(key)};\n`;
}

function generateDirectClientReferenceLoaders(metas: RscClientReferenceMeta[]): string {
  const entries = metas
    .slice()
    .sort((a, b) => a.referenceKey.localeCompare(b.referenceKey))
    .map((meta) => {
      const importId = withResolvedIdProxy(meta.importId);
      return [
        `  ${JSON.stringify(meta.referenceKey)}: async () => {`,
        `    const m = await import(${JSON.stringify(importId)});`,
        `    return ${generateClientReferenceObject(meta)};`,
        `  },`,
      ].join("\n");
    })
    .join("\n");

  return `export default {\n${entries}\n};\n`;
}

export function createRscClientReferenceLoadersPlugin(
  options: RscClientReferenceLoadersOptions,
): Plugin {
  let rscApi: PluginApi | undefined;

  return {
    name: "vinext:rsc-client-reference-loaders",
    enforce: "post",
    configResolved(config) {
      rscApi = (
        config.plugins.find((plugin) => plugin.name === "rsc:minimal") as
          | RscPluginWithApi
          | undefined
      )?.api;
    },
    transform(_code, id) {
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

      return {
        code:
          generateDirectClientReferenceLoaders(metas) +
          generateDynamicPreloadChunksReferenceKey(
            selectDynamicPreloadChunksReferenceKey(metaEntries, options.dynamicPreloadChunksShimId),
          ),
        map: null,
      };
    },
  };
}
