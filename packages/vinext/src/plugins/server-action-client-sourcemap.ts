import path from "pathslash";
import { parseAstAsync, type Plugin } from "vite";
import { stripViteModuleQuery } from "../utils/path.js";

const SCRIPT_EXTENSION_RE = /\.[cm]?([jt]sx?)$/;
const INLINE_SOURCEMAP_RE =
  /(\/\/# sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,)([A-Za-z0-9+/=]+)(\s*)$/;

type SourceMap = { sources?: string[]; sourcesContent?: (string | null)[] };

async function isUseServerModule(code: string, id: string): Promise<boolean> {
  const extension = SCRIPT_EXTENSION_RE.exec(stripViteModuleQuery(id))?.[1];
  const lang = extension === "ts" || extension === "tsx" ? extension : "jsx";
  try {
    const program = await parseAstAsync(code, { lang });
    // Same check as @vitejs/plugin-rsc: a "use server" directive prologue entry.
    return program.body.some(
      (statement) => "directive" in statement && statement.directive === "use server",
    );
  } catch {
    // A later plugin may still compile this script into a "use server"
    // module, so scrub it rather than risk publishing its source.
    return extension !== undefined;
  }
}

/** Null the content of private sources; returns the new JSON when it changed. */
function scrubSourcemap(json: string, isPrivate: (source: string) => boolean): string | null {
  const map = JSON.parse(json) as SourceMap;
  let changed = false;
  map.sources?.forEach((source, index) => {
    if (map.sourcesContent?.[index] != null && isPrivate(source)) {
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
 * Rolldown takes a module's original source from whichever loader returned
 * it, and later transforms cannot replace it. So this records the client
 * modules whose loaded code is a `"use server"` module, then nulls their
 * `sourcesContent` in every emitted map (`.map` assets and inline maps). That
 * holds for any loader, and for sourcemaps enabled late through
 * `outputOptions`. The proxy's mappings still name the module, without its
 * content.
 */
export function createServerActionClientSourcemapPlugin(): Plugin {
  const actionModules = new Map<string, Set<string>>();

  return {
    name: "vinext:server-action-client-sourcemap",
    apply: "build",
    buildStart() {
      if (this.environment?.config.consumer === "client") {
        actionModules.set(this.environment.name, new Set());
      }
    },
    transform: {
      order: "pre",
      filter: { code: "use server" },
      async handler(code, id) {
        const ids = this.environment && actionModules.get(this.environment.name);
        if (ids && (await isUseServerModule(code, id))) ids.add(id);
      },
    },
    generateBundle: {
      order: "post",
      handler(options, bundle) {
        const ids = this.environment && actionModules.get(this.environment.name);
        if (!ids?.size) return;
        const outDir = options.dir ?? path.dirname(options.file ?? "");

        for (const chunk of Object.values(bundle)) {
          if (chunk.type !== "chunk") continue;
          const privateModules = chunk.moduleIds.filter((id) => ids.has(id));
          if (privateModules.length === 0) continue;

          const sourcemapFileName = chunk.sourcemapFileName ?? `${chunk.fileName}.map`;
          const sourcemapPath = path.resolve(outDir, sourcemapFileName);
          const privateSources = new Set(
            privateModules.map((id) => {
              const source = path.relative(path.dirname(sourcemapPath), id);
              return options.sourcemapPathTransform?.(source, sourcemapPath) ?? source;
            }),
          );
          const isPrivate = (source: string) => privateSources.has(source);

          const asset = bundle[sourcemapFileName];
          if (asset?.type === "asset") {
            const scrubbed = scrubSourcemap(String(asset.source), isPrivate);
            if (scrubbed !== null) asset.source = scrubbed;
          }

          const inline = INLINE_SOURCEMAP_RE.exec(chunk.code);
          if (inline) {
            const json = Buffer.from(inline[2]!, "base64").toString("utf8");
            const scrubbed = scrubSourcemap(json, isPrivate);
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
