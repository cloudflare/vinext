import { hash } from "node:crypto";
import type { RscPluginManager } from "@vitejs/plugin-rsc";
import type { Plugin, ResolvedConfig, Rolldown } from "vite";

const INLINE_SOURCEMAP_RE =
  /(\/\/# sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,)([A-Za-z0-9+/=]+)(\s*)$/;

type SourceMap = { sources?: (string | null)[]; sourcesContent?: (string | null)[] };

// A data: URL segment, possibly behind a relative prefix added by Rolldown.
const DATA_URL_SOURCE_RE = /(?:^|\/)(data:[^,]*),(.*)$/is;

const contentHash = (content: string) => hash("sha256", content);

/**
 * The content a data: URL source carries in its name: `undefined` when it is
 * not one, `null` when it cannot be decoded.
 */
function dataUrlContent(source: string | null | undefined): string | null | undefined {
  const match = source && DATA_URL_SOURCE_RE.exec(source);
  if (!match) return undefined;
  try {
    return /;base64$/i.test(match[1]!)
      ? Buffer.from(match[2]!, "base64").toString("utf8")
      : decodeURIComponent(match[2]!);
  } catch {
    return null;
  }
}

/** Every original a map carries, in `sourcesContent` or in a data: URL source. */
function originalContents(map: SourceMap): string[] {
  const contents = (map.sourcesContent ?? []).filter((content) => content != null);
  for (const source of map.sources ?? []) {
    const content = dataUrlContent(source);
    if (content != null) contents.push(content);
  }
  return contents;
}

/** Drop every source whose content is not kept; returns whether anything changed. */
function scrubSourcesContent(map: SourceMap, keep: (content: string) => boolean): boolean {
  let changed = false;
  map.sources?.forEach((source, index) => {
    const content = map.sourcesContent?.[index];
    if (content != null) {
      if (keep(content)) return;
      map.sourcesContent![index] = null;
      changed = true;
    }
    // A data: URL source carries the content itself, with or without a
    // sourcesContent entry.
    const dataContent = dataUrlContent(source);
    if (dataContent === undefined) return;
    if (content == null && dataContent !== null && keep(dataContent)) return;
    map.sources![index] = "data:,";
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
 * `.map` asset and any inline map, both before and after other
 * `generateBundle` hooks. That holds for any loader and for sourcemaps enabled
 * late through `outputOptions`. Action modules are the ones
 * plugin-rsc itself registered as server references; its client transform
 * drops the claim for every module it does not proxy. In a chunk containing
 * one, a source keeps its content only when that content belongs to one of
 * the chunk's other modules: their code when this plugin's transform first
 * sees them, or an original their combined map points to after every
 * transform. Matching content rather than source names holds for colliding
 * names, loader-supplied maps and custom map locations. The proxy's mappings still
 * name the action module, without its content.
 */
export function createServerActionClientSourcemapPlugin(options: {
  getManager: (config: ResolvedConfig) => Promise<RscPluginManager | undefined>;
}): Plugin[] {
  let config: ResolvedConfig;
  const loadedCode = new Map<string, Map<string, string[]>>();
  const getHashes = (environment: { name: string } | undefined) =>
    environment && loadedCode.get(environment.name);

  async function scrubBundle(
    environment: { name: string } | undefined,
    bundle: Rolldown.OutputBundle,
  ) {
    const hashes = getHashes(environment);
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
      // Rolldown sets `sourcemapFileName` only when it emits an external map.
      const asset = chunk.sourcemapFileName ? bundle[chunk.sourcemapFileName] : undefined;
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
  }

  const scrub: Plugin = {
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
        const hashes = getHashes(this.environment);
        if (!hashes) return;
        hashes.set(id, [contentHash(code)]);
      },
    },
    // Scrub before other `generateBundle` hooks can copy the maps.
    generateBundle: {
      order: "pre",
      handler(_outputOptions, bundle) {
        return scrubBundle(this.environment, bundle);
      },
    },
  };

  // Loaders and any transform can map a public module back to another
  // original, so record its combined map once every transform has run. Read it
  // even without a configured sourcemap: `outputOptions` can still enable one.
  const track: Plugin = {
    name: "vinext:server-action-client-sourcemap:track",
    apply: "build",
    enforce: "post",
    transform: {
      order: "post",
      handler(_code, id) {
        const hashes = getHashes(this.environment)?.get(id);
        if (!hashes) return;
        try {
          for (const content of originalContents(this.getCombinedSourcemap())) {
            hashes.push(contentHash(content));
          }
        } catch {}
      },
    },
    // Scrub again after the other `generateBundle` hooks have run.
    generateBundle: {
      order: "post",
      handler(_outputOptions, bundle) {
        return scrubBundle(this.environment, bundle);
      },
    },
  };

  return [scrub, track];
}
