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

export function serializeViteDefine(value: unknown): string {
  if (typeof value === "string") return value;
  // Vite treats define values as raw expressions, so explicit `undefined`
  // must become the bare expression rather than the string `"undefined"`.
  return JSON.stringify(value) ?? "undefined";
}

export function getDepOptimizeNodeEnvOptions(
  viteMajorVersion: number,
  nodeEnvDefine: string,
): {
  rolldownOptions?: {
    transform: {
      define: Record<string, string>;
    };
    moduleTypes?: Record<string, "jsx">;
  };
  esbuildOptions?: {
    define: Record<string, string>;
    loader?: Record<string, "jsx">;
  };
} {
  // Vite defaults keepProcessEnv to true for server-consumer environments,
  // which also disables its built-in optimizer NODE_ENV replacement. Pin the
  // value explicitly so RSC and SSR dependencies can drop the unused branch.
  const define = {
    "process.env.NODE_ENV": nodeEnvDefine,
  };

  // The dep optimizer scanner and pre-bundler run their own Rolldown/esbuild
  // pipeline that does NOT go through the `vinext:jsx-in-js` transform plugin
  // (which only runs in the Vite plugin pipeline). Next.js allows JSX in plain
  // `.js`/`.mjs` files, and the scanner crawls the app's source entries to
  // discover dependencies — so JSX in a `.js`/`.mjs` source file makes the
  // scanner fail with "Unexpected JSX expression" and aborts pre-bundling.
  // Force the optimizer to treat `.js`/`.mjs` as JSX so it parses the same
  // syntax that the main transform accepts for app source. Unlike the
  // `vinext:jsx-in-js` transform, this is an optimizer-wide extension mapping
  // and can also apply to dependencies that the optimizer pre-bundles.
  //
  // The motivating symptom is that, once the scan aborts, pre-bundling is
  // skipped and UMD/CJS deps can fail to interop under SSR — but that
  // downstream behavior runs through a different optimizer path and is not
  // what this option is verified to address; this only keeps the scan from
  // aborting on JSX-in-`.js`/`.mjs`.
  const jsxModuleTypes = { ".js": "jsx", ".mjs": "jsx" } as const;
  return viteMajorVersion >= 8
    ? {
        rolldownOptions: {
          transform: { define },
          moduleTypes: jsxModuleTypes,
        },
      }
    : {
        esbuildOptions: { define, loader: jsxModuleTypes },
      };
}

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
