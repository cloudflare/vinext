import type { Plugin } from "vite";
import type { PluginApi } from "@vitejs/plugin-rsc";

const CLIENT_REFERENCES_ID = "\0virtual:vite-rsc/client-references";
const RESOLVED_ID_PROXY_PREFIX = "virtual:vite-rsc/resolved-id/";
const DEV_CLIENT_REFERENCE_WARMUP_IDS = Object.freeze([
  "virtual:vite-rsc/remove-duplicate-server-css",
]);

type RscClientReferenceMeta = PluginApi["manager"]["clientReferenceMetaMap"][string];

type RscPluginWithApi = Plugin & {
  api?: PluginApi;
};

function getRscApi(plugins: readonly Plugin[]): PluginApi | undefined {
  return (plugins.find((plugin) => plugin.name === "rsc:minimal") as RscPluginWithApi | undefined)
    ?.api;
}

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

async function warmupRscDevClientReferences(rscApi: PluginApi | undefined): Promise<void> {
  const manager = rscApi?.manager;
  if (!manager || manager.config.command !== "serve") return;

  const rscEnv = manager.server?.environments["rsc"];
  if (!rscEnv) return;

  for (const source of DEV_CLIENT_REFERENCE_WARMUP_IDS) {
    const resolved = await rscEnv.pluginContainer.resolveId(source, undefined);
    await rscEnv.transformRequest(resolved?.id ?? source);
  }
}

export function createRscClientReferenceLoadersPlugin(): Plugin {
  let rscApi: PluginApi | undefined;
  let devClientReferenceWarmup: Promise<void> | null = null;

  return {
    name: "vinext:rsc-client-reference-loaders",
    enforce: "post",
    configResolved(config) {
      rscApi = getRscApi(config.plugins);
    },
    async transform(_code, id) {
      if (id !== CLIENT_REFERENCES_ID) return null;

      const manager = rscApi?.manager;
      if (!manager || manager.isScanBuild) return null;
      if (!devClientReferenceWarmup) {
        devClientReferenceWarmup = warmupRscDevClientReferences(rscApi).catch(() => {});
      }
      await devClientReferenceWarmup;

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
        code: generateDirectClientReferenceLoaders(metas),
        map: null,
      };
    },
  };
}
