import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

/**
 * Absolute path to the `@vinext/cloudflare` cache source.
 *
 * vinext consumes a few runtime helpers from `@vinext/cloudflare`
 * (`KVCacheHandler`, `CloudflareCdnCacheAdapter`, `ENTRY_PREFIX`). Keeping it as
 * an external runtime `dependency` created a cycle
 * (`vinext` -> `@vinext/cloudflare` -> `vinext`, the latter via its `peerDep`),
 * which forced changesets to force-major `@vinext/cloudflare` on every vinext
 * release. Bundling that surface lets `@vinext/cloudflare` stay a dev-only
 * dependency, so the install graph only points one way
 * (`@vinext/cloudflare` -> `vinext`).
 */
const cloudflareCacheSrc = fileURLToPath(new URL("../cloudflare/src/cache", import.meta.url));

export default defineConfig({
  pack: {
    entry: ["src/**/*.ts", "src/**/*.tsx", "!src/**/*.d.ts"],
    clean: true,
    deps: {
      // Agent detection is a CLI implementation detail, so inline it rather
      // than requiring vinext consumers to install it.
      alwaysBundle: ["am-i-vibing", "process-ancestry"],
      neverBundle: (id) =>
        id.includes("node_modules") &&
        !id.includes("am-i-vibing") &&
        !id.includes("process-ancestry"),
    },
    // Bundle `@vinext/cloudflare` in by aliasing its `cache/*` subpath to source.
    // The alias rewrites imports to local source so the small runtime helper
    // surface remains bundled without creating a package dependency cycle.
    inputOptions: {
      resolve: {
        alias: {
          "@vinext/cloudflare/cache": cloudflareCacheSrc,
        },
      },
    },
    dts: true,
    fixedExtension: false,
    format: "esm",
    unbundle: true,
  },
});
