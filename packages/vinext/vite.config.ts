import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/**/*.ts", "src/**/*.tsx", "!src/**/*.d.ts"],
    clean: true,
    deps: {
      // vinext requires *all* node_modules imports to stay external by default:
      // many `next/*` and other bare imports are re-resolved/aliased inside the
      // user's build, so bundling the real packages here would break that.
      // `skipNodeModulesBundle` would do that, but it is mutually exclusive with
      // `alwaysBundle`. So we replicate it with `neverBundle` (externalize every
      // bare specifier) and carve out the leaves we want to inline.
      //
      // We inline only zero-dependency leaf utilities that vinext uses
      // internally: they have no transitive deps and are never imported directly
      // by user code, so there is no benefit to resolving them separately.
      // Bundling shrinks the install footprint and supply-chain surface.
      alwaysBundle: ["ipaddr.js", "web-vitals", "image-size"],
      neverBundle: (id: string) =>
        /^[^./]/.test(id) && !["ipaddr.js", "web-vitals", "image-size"].includes(id),
      // Guard: fail the build if anything other than these three ever gets
      // inlined, so a future stray import can't silently bundle a large package.
      onlyBundle: ["ipaddr.js", "web-vitals", "image-size"],
    },
    dts: true,
    fixedExtension: false,
    format: "esm",
    sourcemap: true,
    unbundle: true,
  },
});
