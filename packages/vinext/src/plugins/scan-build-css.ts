import type { Plugin } from "vite";
import type { PluginApi } from "@vitejs/plugin-rsc";

// The same stylesheet languages and special queries that Vite's `vite:css`
// transform filter uses, so this matches exactly the modules Vite compiles as
// CSS. `?url`, `?raw` and worker imports load as JavaScript and are left alone.
const CSS_LANGS_RE = /\.(?:css|less|sass|scss|styl|stylus|pcss|postcss|sss)(?:$|\?)/;
const SPECIAL_QUERY_RE = /[?&](?:worker|sharedworker|raw|url)\b/;
// Plugin-owned virtual modules may use a stylesheet-looking id for other content.
// oxlint-disable-next-line no-control-regex -- null byte prefix is intentional (Vite virtual module convention)
const VIRTUAL_MODULE_RE = /^\0/;

type RscPluginWithApi = Plugin & {
  api?: PluginApi;
};

/**
 * @vitejs/plugin-rsc discovers client and server references with two
 * write-less scan builds whose output is discarded, and its `rsc:scan-strip`
 * plugin reduces every module to its import specifiers. A stylesheet cannot
 * contribute a JavaScript import, yet without this plugin every stylesheet in
 * the app still ran through PostCSS/Tailwind/Sass in both scans. Empty their
 * source during those scans only; real builds and dev are unchanged.
 */
export function createScanBuildCssPlugin(): Plugin {
  let rscApi: PluginApi | undefined;

  return {
    name: "vinext:scan-build-css",
    enforce: "pre",
    apply: "build",
    configResolved(config) {
      rscApi = (
        config.plugins.find((plugin) => plugin.name === "rsc:minimal") as
          | RscPluginWithApi
          | undefined
      )?.api;
    },
    transform: {
      // Run before other stylesheet transforms, such as Tailwind's
      // `enforce: "pre"` plugin, so none of them process the discarded source.
      order: "pre",
      filter: {
        id: { include: CSS_LANGS_RE, exclude: [SPECIAL_QUERY_RE, VIRTUAL_MODULE_RE] },
      },
      handler() {
        // plugin-rsc disables `build.write` only for its scan builds; checking
        // both keeps any other write-less build's CSS output intact.
        if (!rscApi?.manager.isScanBuild || this.environment.config.build.write !== false) {
          return null;
        }
        return { code: "", map: null };
      },
    },
  };
}
