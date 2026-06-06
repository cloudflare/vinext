import { isAbsolute } from "node:path";
import { defineConfig } from "vite-plus";

/**
 * Dependencies bundled into vinext's `dist` instead of being kept external.
 *
 * vinext consumes a few runtime helpers from `@vinext/cloudflare`
 * (`KVCacheHandler`, `CloudflareCdnCacheAdapter`, `ENTRY_PREFIX`). Keeping it as
 * an external runtime `dependency` created a cycle
 * (`vinext` -> `@vinext/cloudflare` -> `vinext`, the latter via its `peerDep`),
 * which forced changesets to force-major `@vinext/cloudflare` on every vinext
 * release. Bundling that small surface lets `@vinext/cloudflare` stay a dev-only
 * dependency, so the install graph only points one way
 * (`@vinext/cloudflare` -> `vinext`).
 *
 * `@vinext/cloudflare` is still published independently: user `vite.config`
 * files import its `cdnAdapter()` / `kvDataAdapter()` builders, and the
 * generated worker resolves its `*.runtime.js` factories by absolute path. The
 * bundled-in code's `vinext/shims/*` imports stay external and resolve through
 * vinext's own package exports at runtime (Node self-referencing).
 */
const BUNDLED_DEPS = ["@vinext/cloudflare"];

/**
 * Externalize every bare import (npm packages, `node:` builtins, `next/*` and
 * `vinext/*` specifiers resolved by the plugin, `virtual:*` ids) — i.e. the
 * behaviour of `deps.skipNodeModulesBundle` — except the deps in
 * {@link BUNDLED_DEPS}, which are bundled in.
 *
 * The carve-out has to live inside `neverBundle`: tsdown rejects
 * `skipNodeModulesBundle` + `alwaysBundle` as mutually exclusive, and a
 * catch-all `neverBundle` takes precedence over `alwaysBundle`, so the only
 * place to force a single dep to be bundled is here.
 */
const externalizeAllExceptBundled = (id: string): boolean => {
  if (BUNDLED_DEPS.some((dep) => id === dep || id.startsWith(`${dep}/`))) {
    return false;
  }
  return !id.startsWith(".") && !isAbsolute(id);
};

export default defineConfig({
  pack: {
    entry: ["src/**/*.ts", "src/**/*.tsx", "!src/**/*.d.ts"],
    clean: true,
    deps: {
      neverBundle: externalizeAllExceptBundled,
      dts: { neverBundle: externalizeAllExceptBundled },
    },
    dts: true,
    fixedExtension: false,
    format: "esm",
    unbundle: true,
  },
});
