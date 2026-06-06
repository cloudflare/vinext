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
      // Keep externalizing node_modules (and rewriting vinext's own
      // `vinext/shims/*` tsconfig-path self-imports to relative). This must stay
      // untouched: replacing it with a custom external predicate breaks the
      // self-import rewrite and duplicates shim modules across Vite's separate
      // RSC/SSR/client dev graphs (e.g. `instanceof ReadonlyURLSearchParams`).
      skipNodeModulesBundle: true,
    },
    // Bundle `@vinext/cloudflare` in by aliasing its `cache/*` subpath to source.
    // `skipNodeModulesBundle` externalizes bare package specifiers before
    // tsconfig paths apply, so the alias rewrites the import to a file path up
    // front — tsdown then treats it as local source and bundles it. The
    // bundled code's own `vinext/shims/*` imports still resolve to vinext's
    // relative output (single module instance). `@vinext/cloudflare` remains a
    // published package: user `vite.config` files import its `cdnAdapter()` /
    // `kvDataAdapter()` builders, and the generated worker resolves its
    // `*.runtime.js` factories by absolute path.
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
