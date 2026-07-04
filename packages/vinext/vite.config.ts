import { defineConfig } from "vite-plus";

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
  if (id === "am-i-vibing" || id === "process-ancestry") return false;
  return true;
};

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
    inputOptions: {
      external: externalizeBareThirdPartySpecifiers,
    },
    dts: true,
    fixedExtension: false,
    format: "esm",
    unbundle: true,
  },
});
