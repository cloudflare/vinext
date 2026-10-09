import fs from "node:fs/promises";
import type { Plugin } from "vite";
import { getBuildBundlerOptions } from "../build/client-build-config.js";
import { getLeadingReactDirective } from "../utils/react-directive.js";

type SourcemapBuildConfig = Parameters<typeof getBuildBundlerOptions>[0] & {
  sourcemap?: boolean | "inline" | "hidden";
};

function hasClientSourcemaps(build: SourcemapBuildConfig): boolean {
  if (build?.sourcemap) return true;
  const output = getBuildBundlerOptions(build)?.output;
  const outputs = Array.isArray(output) ? output : [output];
  return outputs.some((options) => Boolean(options?.sourcemap));
}

/**
 * Keep `"use server"` module source out of production browser sourcemaps.
 *
 * In client environments `@vitejs/plugin-rsc` replaces a `"use server"`
 * module with `createServerReference()` proxies, so its implementation never
 * reaches browser JavaScript. Rolldown still seeds the module's sourcemap
 * chain with the loaded file, so an enabled client sourcemap would publish
 * the full server-only source in `sourcesContent`. A later transform cannot
 * remove it: Rolldown keeps the first map's sources even when the final
 * mappings no longer point at them.
 *
 * Loading the module with an empty map starts the chain with no original
 * source, so the generated proxy maps to nothing and the module disappears
 * from the emitted map. This matches Next.js, which drops the original
 * mappings when compiling server actions for the client in production builds
 * and keeps them in development and server builds:
 * crates/next-custom-transforms/src/transforms/server_actions.rs (#76157),
 * test/e2e/app-dir/actions/app-action.test.ts
 * ("should not expose action content in sourcemaps").
 *
 * Known limitations: a user `enforce: "pre"` loader that returns the module
 * first keeps its own map, query-suffixed ids are left to the default loader
 * (`?raw`, `?url` and similar must not load as modules), and sourcemaps
 * enabled only through an `outputOptions` hook are not detected. Checking the
 * resolved config keeps builds without sourcemaps from reading every client
 * module twice.
 */
export function createServerActionClientSourcemapPlugin(): Plugin {
  return {
    name: "vinext:server-action-client-sourcemap",
    apply: "build",
    enforce: "pre",
    load: {
      filter: { id: { include: /\.[cm]?[jt]sx?$/, exclude: /[\0?]/ } },
      async handler(id) {
        const config = this.environment?.config;
        if (config?.consumer !== "client" || !hasClientSourcemaps(config.build)) return null;

        let code: string;
        try {
          code = await fs.readFile(id, "utf8");
        } catch {
          return null;
        }
        if (getLeadingReactDirective(code) !== "use server") return null;
        return { code, map: { mappings: "" } };
      },
    },
  };
}
