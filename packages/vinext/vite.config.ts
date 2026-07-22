import { defineConfig } from "vite-plus";

const typescriptPackageUrl = import.meta.resolve("typescript/package.json");
const { default: getTscPath } = await import(
  new URL("lib/getExePath.js", typescriptPackageUrl).href
);

/**
 * Keep third-party bare specifiers external — even when imported dynamically.
 *
 * `deps.neverBundle` (below) decides externalization on the *resolved* id
 * (`id.includes("node_modules")`). Rolldown already preserves the bare specifier
 * for *static* imports, but for a *dynamic* `await import("react")` it resolves
 * the literal to an absolute path inside vinext's own `node_modules` *before*
 * `neverBundle` runs, then bakes that path into `dist`
 * (e.g. `import("/<vinext>/node_modules/.pnpm/next@.../next/router.js")`). That
 * path only exists on the machine that built vinext, so on any other machine —
 * including CI and every consumer — the build fails with
 * `[UNRESOLVED_IMPORT] Could not resolve '/.../next/router.js'`. This regressed
 * every dynamically-imported peer/dependency (`next/router`, `react`,
 * `react-dom/*`, `vite`, `@vercel/og`, `@vitejs/plugin-rsc`, ...) when
 * `skipNodeModulesBundle: true` — which externalized on the *unresolved* bare
 * specifier — was replaced by the `neverBundle` predicate.
 *
 * Deciding on the unresolved specifier restores that behaviour, so dynamic
 * imports stay bare like static ones. `isResolved` short-circuits to keep the
 * resolved-path branch owned by `neverBundle`.
 */
const isFirstParty = (id: string) => id === "vinext" || id.startsWith("vinext/");

/**
 * Keep `alwaysBundle`d dependencies out of `dist/node_modules/...`.
 *
 * The unbundled output mirrors each inlined dependency's on-disk location, so
 * it lands under `dist/node_modules/.pnpm/<pkg>/node_modules/<pkg>/...`. Any
 * consumer that prunes nested `node_modules` then silently drops it — most
 * importantly our own standalone output assembly (`build/standalone.ts`
 * filters out every path containing a `node_modules` segment when copying the
 * app's packages), which left `dist/server/prod-server.js`'s pathslash import
 * dangling and crashed the standalone server on boot. Renaming the emitted
 * files to a `deps` segment keeps the mirror layout but survives such pruning.
 */
const renameBundledDepsOutput = (chunk: { name: string }) =>
  `${chunk.name.replaceAll("node_modules", "deps")}.js`;

const externalizeBareThirdPartySpecifiers = (
  id: string,
  _importer: string | undefined,
  isResolved: boolean,
) => {
  if (isResolved) return false;
  // Relative/absolute paths, virtual modules, and protocol-prefixed ids
  // resolve normally.
  if (id.startsWith(".") || id.startsWith("/") || id.startsWith("\0") || id.includes(":")) {
    return false;
  }
  // First-party `vinext` self-imports must keep resolving so the
  // shim modules are emitted relative and shared as a single instance across
  // Vite's separate RSC/SSR/client graphs (e.g. `instanceof
  // ReadonlyURLSearchParams`).
  if (isFirstParty(id)) return false;
  // Packages inlined into `dist` via `alwaysBundle` must keep resolving so they
  // get bundled rather than externalized.
  if (id === "am-i-vibing" || id === "process-ancestry" || id === "pathslash") return false;
  return true;
};

export default defineConfig({
  pack: {
    entry: ["src/**/*.ts", "src/**/*.tsx", "!src/**/*.d.ts"],
    clean: true,
    deps: {
      // Agent detection is a CLI implementation detail, so inline it rather
      // than requiring vinext consumers to install it. Same for pathslash:
      // it is our own ~90-line node:path wrapper (zero deps), so bundling it
      // keeps it out of consumers' install graphs.
      alwaysBundle: ["am-i-vibing", "process-ancestry", "pathslash"],
      neverBundle: (id) =>
        id.includes("node_modules") &&
        !id.includes("am-i-vibing") &&
        !id.includes("process-ancestry") &&
        !id.includes("pathslash"),
    },
    inputOptions: {
      external: externalizeBareThirdPartySpecifiers,
    },
    outputOptions: {
      entryFileNames: renameBundledDepsOutput,
      chunkFileNames: renameBundledDepsOutput,
    },
    dts: {
      tsgo: { path: getTscPath() },
    },
    copy: [
      {
        from: "src/shims/next-shims-public.d.ts",
        to: "dist/shims",
        flatten: true,
      },
      {
        from: "src/shims/next-shims-augmentations.d.ts",
        to: "dist/shims",
        flatten: true,
      },
    ],
    fixedExtension: false,
    format: "esm",
    unbundle: true,
  },
});
