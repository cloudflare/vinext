import { hash } from "node:crypto";
import type { RscPluginManager } from "@vitejs/plugin-rsc";
import type { Plugin, ResolvedConfig } from "vite";
import { getBuildBundlerOptions } from "../build/client-build-config.js";

const INLINE_SOURCEMAP_RE =
  /(\/\/# sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,)([A-Za-z0-9+/=]+)(\s*)$/;

type SourceMap = { sources?: (string | null)[]; sourcesContent?: (string | null)[] };
type BuildConfig = Parameters<typeof getBuildBundlerOptions>[0] & {
  sourcemap?: boolean | "inline" | "hidden";
};

const contentHash = (content: string) => hash("sha256", content);

function hasConfiguredSourcemaps(build: BuildConfig): boolean {
  if (build?.sourcemap) return true;
  const output = getBuildBundlerOptions(build)?.output;
  return (Array.isArray(output) ? output : [output]).some((options) => options?.sourcemap);
}

/** Null every source content not kept; returns whether anything changed. */
function scrubSourcesContent(map: SourceMap, keep: (content: string) => boolean): boolean {
  let changed = false;
  map.sourcesContent?.forEach((content, index) => {
    if (content == null || keep(content)) return;
    map.sourcesContent![index] = null;
    // A data: URL source carries the content itself (Rolldown may prefix it
    // with a relative path).
    if (/data:/i.test(map.sources?.[index] ?? "")) map.sources![index] = "data:,";
    changed = true;
  });
  return changed;
}

function scrubSourcemapJson(
  source: string | Uint8Array,
  keep: (content: string) => boolean,
): string | null {
  const json = typeof source === "string" ? source : Buffer.from(source).toString("utf8");
  const map = JSON.parse(json) as SourceMap;
  return scrubSourcesContent(map, keep) ? JSON.stringify(map) : null;
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
 * replace it. So this scrubs the emitted maps instead: the chunk's `map`, its
 * `.map` asset and any inline map. That holds for any loader and for
 * sourcemaps enabled late through `outputOptions`. Action modules are the ones
 * plugin-rsc itself registered as server references; its client transform
 * drops the claim for every module it does not proxy. In a chunk containing
 * one, a source keeps its content only when that content belongs to one of
 * the chunk's other modules: their code when this plugin's transform first
 * sees them, or an original their combined map already points to. Matching
 * content rather than source names holds for colliding names,
 * loader-supplied maps and custom map locations. The proxy's mappings still
 * name the action module, without its content.
 */
export function createServerActionClientSourcemapPlugin(options: {
  getManager: (config: ResolvedConfig) => Promise<RscPluginManager | undefined>;
}): Plugin {
  let config: ResolvedConfig;
  const loadedCode = new Map<string, Map<string, string[]>>();

  return {
    name: "vinext:server-action-client-sourcemap",
    apply: "build",
    configResolved(resolvedConfig) {
      config = resolvedConfig;
    },
    buildStart() {
      if (this.environment?.config.consumer === "client") {
        loadedCode.set(this.environment.name, new Map());
      }
    },
    transform: {
      order: "pre",
      handler(code, id) {
        const hashes = this.environment && loadedCode.get(this.environment.name);
        if (!hashes) return;
        const contents = [code];
        // Earlier loaders and `enforce: "pre"` transforms can already map the
        // code back to another original. Reading the combined map costs a
        // collapse per module, so skip it when no sourcemap is configured;
        // missing it only nulls more content.
        if (hasConfiguredSourcemaps(this.environment.config.build)) {
          try {
            for (const content of this.getCombinedSourcemap().sourcesContent ?? []) {
              if (content != null) contents.push(content);
            }
          } catch {}
        }
        hashes.set(id, contents.map(contentHash));
      },
    },
    generateBundle: {
      order: "post",
      async handler(_outputOptions, bundle) {
        const hashes = this.environment && loadedCode.get(this.environment.name);
        if (!hashes) return;
        const serverReferences = (await options.getManager(config))?.serverReferences.metaMap;
        if (!serverReferences?.size) return;

        for (const chunk of Object.values(bundle)) {
          if (chunk.type !== "chunk") continue;
          if (!chunk.moduleIds.some((id) => serverReferences.has(id))) continue;

          const publicContent = new Set(
            chunk.moduleIds
              .filter((id) => !serverReferences.has(id))
              .flatMap((id) => hashes.get(id) ?? []),
          );
          const keep = (content: string) => publicContent.has(contentHash(content));

          // Rolldown only syncs top-level assignments back from the bundle.
          const map = chunk.map;
          if (map && scrubSourcesContent(map, keep)) chunk.map = map;
          const asset = bundle[chunk.sourcemapFileName ?? `${chunk.fileName}.map`];
          if (asset?.type === "asset") {
            const scrubbed = scrubSourcemapJson(asset.source, keep);
            if (scrubbed !== null) asset.source = scrubbed;
          }

          const inline = INLINE_SOURCEMAP_RE.exec(chunk.code);
          if (inline) {
            const json = Buffer.from(inline[2]!, "base64").toString("utf8");
            const scrubbed = scrubSourcemapJson(json, keep);
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
