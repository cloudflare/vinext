/**
 * Vite major-version detection.
 *
 * Several vinext behaviors depend on whether the host project is running Vite 8
 * (Rolldown-based, with native `resolve.tsconfigPaths`, `oxc` transforms, and
 * `rolldownOptions`) or Vite 7 (Rollup/esbuild). This helper centralizes the
 * detection so the Vite-major gate is computed the same way everywhere.
 */
import path from "node:path";
import { createRequire } from "node:module";

/**
 * Detect Vite major version at runtime by resolving from cwd.
 * The plugin may be installed in a workspace root with Vite 7 but used
 * by a project that has Vite 8 — so we resolve from cwd, not from
 * the plugin's own location.
 */
export function getViteMajorVersion(): number {
  try {
    const require = createRequire(path.join(process.cwd(), "package.json"));
    const vitePkg = require("vite/package.json");

    const viteMajor = parseInt(vitePkg?.version, 10);
    if (vitePkg?.name === "vite" && Number.isFinite(viteMajor)) {
      return viteMajor;
    }

    const bundledViteMajor = parseInt(vitePkg?.bundledVersions?.vite, 10);
    if (Number.isFinite(bundledViteMajor)) {
      return bundledViteMajor;
    }

    // npm aliases like `vite: npm:@voidzero-dev/vite-plus-core@...` expose the
    // aliased package.json, whose own version is not Vite's version.
    console.warn(
      `[vinext] Could not determine Vite major version from ${vitePkg?.name ?? "vite/package.json"}; assuming Vite 7`,
    );
    return 7;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[vinext] Failed to resolve vite/package.json (${message}); assuming Vite 7`);
    return 7;
  }
}
