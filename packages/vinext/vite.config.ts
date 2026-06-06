import { defineConfig } from "vite-plus";

/**
 * Externalize every bare specifier (npm packages, `node:` builtins, `vinext/*`
 * self-references, `virtual:*` ids) so the published `dist` keeps its imports —
 * EXCEPT `@vinext/cloudflare`, which is bundled in.
 *
 * vinext consumes a handful of runtime helpers from `@vinext/cloudflare`
 * (`KVCacheHandler`, `CloudflareCdnCacheAdapter`, `ENTRY_PREFIX`). Importing
 * them as an external runtime dependency created a dependency cycle
 * (`vinext` -> `@vinext/cloudflare` -> `vinext`), which forced changesets to
 * force-major `@vinext/cloudflare` on every vinext release. Bundling the small
 * amount of code vinext actually uses lets `@vinext/cloudflare` stay a
 * dev-only dependency, so the install graph only points one way
 * (`@vinext/cloudflare` -> `vinext`).
 *
 * `@vinext/cloudflare` itself remains a published package: user `vite.config`
 * files import its `cdnAdapter()` / `kvDataAdapter()` builders, and the
 * generated worker resolves its `*.runtime.js` factories by absolute path. Its
 * internal `vinext/shims/*` imports stay external here and resolve through
 * vinext's own package exports at runtime (Node self-referencing).
 */
const externalizeExceptCloudflare = (id: string): boolean => {
  if (id === "@vinext/cloudflare" || id.startsWith("@vinext/cloudflare/")) {
    return false; // bundle it
  }
  // Bundle relative/absolute (our own source); externalize everything else.
  const isInternal = id.startsWith(".") || id.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(id);
  return !isInternal;
};

export default defineConfig({
  pack: {
    entry: ["src/**/*.ts", "src/**/*.tsx", "!src/**/*.d.ts"],
    clean: true,
    deps: {
      // `skipNodeModulesBundle` can't be combined with bundling a specific dep,
      // so we replicate "externalize node_modules" via `neverBundle` and carve
      // out `@vinext/cloudflare` to be bundled in.
      neverBundle: externalizeExceptCloudflare,
      dts: { neverBundle: externalizeExceptCloudflare },
    },
    dts: true,
    fixedExtension: false,
    format: "esm",
    unbundle: true,
  },
});
