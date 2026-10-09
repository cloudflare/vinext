import type { RscPluginManager } from "@vitejs/plugin-rsc";
import path from "pathslash";
import type { Plugin, ResolvedConfig } from "vite";

const INLINE_SOURCEMAP_RE =
  /(\/\/# sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,)([A-Za-z0-9+/=]+)(\s*)$/;

type SourceMap = { sources?: string[]; sourcesContent?: (string | null)[] };

/** Null the content of every source not kept; returns the new JSON when it changed. */
function scrubSourcemap(json: string, keep: (source: string) => boolean): string | null {
  const map = JSON.parse(json) as SourceMap;
  let changed = false;
  map.sources?.forEach((source, index) => {
    if (map.sourcesContent?.[index] != null && !keep(source)) {
      map.sourcesContent[index] = null;
      changed = true;
    }
  });
  return changed ? JSON.stringify(map) : null;
}

/**
 * Keep `"use server"` module source out of production browser sourcemaps.
 *
 * In client environments `@vitejs/plugin-rsc` replaces a `"use server"`
 * module with `createServerReference()` proxies, so its implementation never
 * reaches browser JavaScript. Rolldown still records the module's loaded
 * source as the original in the chunk's sourcemap, so an enabled client
 * sourcemap would publish the full server-only module in `sourcesContent`.
 *
 * Next.js drops the original mappings when compiling server actions for the
 * client in production builds, and keeps them in development and server builds:
 * crates/next-custom-transforms/src/transforms/server_actions.rs (#76157),
 * test/e2e/app-dir/actions/app-action.test.ts
 * ("should not expose action content in sourcemaps").
 *
 * Rolldown takes a module's original source from whichever loader returned it
 * (including any map that loader supplied), and later transforms cannot
 * replace it. So this scrubs the emitted maps instead (`.map` assets and
 * inline maps), which holds for any loader and for sourcemaps enabled late
 * through `outputOptions`. Action modules are the ones plugin-rsc itself
 * registered as server references; its client transform drops the claim for
 * every module it does not proxy. In a chunk containing one, only the sources
 * that match the chunk's other modules keep their content. The proxy's
 * mappings still name the action module, without its content.
 */
export function createServerActionClientSourcemapPlugin(options: {
  getManager: (config: ResolvedConfig) => Promise<RscPluginManager | undefined>;
}): Plugin {
  let config: ResolvedConfig;

  return {
    name: "vinext:server-action-client-sourcemap",
    apply: "build",
    configResolved(resolvedConfig) {
      config = resolvedConfig;
    },
    generateBundle: {
      order: "post",
      async handler(outputOptions, bundle) {
        if (this.environment?.config.consumer !== "client") return;
        const serverReferences = (await options.getManager(config))?.serverReferences.metaMap;
        if (!serverReferences?.size) return;
        const outDir = outputOptions.dir ?? path.dirname(outputOptions.file ?? "");

        for (const chunk of Object.values(bundle)) {
          if (chunk.type !== "chunk") continue;
          if (!chunk.moduleIds.some((id) => serverReferences.has(id))) continue;

          const sourcemapFileName = chunk.sourcemapFileName ?? `${chunk.fileName}.map`;
          const sourcemapPath = path.resolve(outDir, sourcemapFileName);
          const publicSources = new Set(
            chunk.moduleIds
              .filter((id) => !serverReferences.has(id))
              .map((id) => {
                const source = path.relative(path.dirname(sourcemapPath), id);
                return outputOptions.sourcemapPathTransform?.(source, sourcemapPath) ?? source;
              }),
          );
          const keep = (source: string) => publicSources.has(source);

          const asset = bundle[sourcemapFileName];
          if (asset?.type === "asset") {
            const scrubbed = scrubSourcemap(String(asset.source), keep);
            if (scrubbed !== null) asset.source = scrubbed;
          }

          const inline = INLINE_SOURCEMAP_RE.exec(chunk.code);
          if (inline) {
            const json = Buffer.from(inline[2]!, "base64").toString("utf8");
            const scrubbed = scrubSourcemap(json, keep);
            if (scrubbed !== null) {
              chunk.code =
                chunk.code.slice(0, inline.index) +
                inline[1] +
                Buffer.from(scrubbed).toString("base64") +
                inline[3];
            }
          }
        }
      },
    },
  };
}
