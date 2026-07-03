/**
 * Vite major-version detection.
 *
 * vinext requires Vite 8 or newer so it can rely on Rolldown-based build
 * options, native `resolve.tsconfigPaths`, and OXC transforms.
 */
import path from "pathslash";
import { createRequire } from "node:module";

export function serializeViteDefine(value: unknown): string {
  if (typeof value === "string") return value;
  // Vite treats define values as raw expressions, so explicit `undefined`
  // must become the bare expression rather than the string `"undefined"`.
  return JSON.stringify(value) ?? "undefined";
}

export function getDepOptimizeNodeEnvOptions(nodeEnvDefine: string): {
  rolldownOptions?: {
    transform: {
      define: Record<string, string>;
    };
    moduleTypes?: Record<string, "jsx">;
  };
} {
  // Vite defaults keepProcessEnv to true for server-consumer environments,
  // which also disables its built-in optimizer NODE_ENV replacement. Pin the
  // value explicitly so RSC and SSR dependencies can drop the unused branch.
  const define = {
    "process.env.NODE_ENV": nodeEnvDefine,
  };

  // The dep optimizer scanner and pre-bundler run their own Rolldown
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
  return {
    rolldownOptions: {
      transform: { define },
      moduleTypes: jsxModuleTypes,
    },
  };
}

/**
 * Detect Vite major version at runtime. Prefer the project cwd, then fall back
 * to vinext's own dependency graph for tests and linked source checkouts.
 */
function getViteMajorVersion(): number {
  try {
    return getViteMajorVersionFromRequire(createRequire(path.join(process.cwd(), "package.json")));
  } catch (error) {
    if (!isModuleNotFoundError(error)) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`[vinext] Vite 8 or newer is required, but ${message}`);
    }
  }

  try {
    return getViteMajorVersionFromRequire(createRequire(import.meta.url));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `[vinext] Vite 8 or newer is required, but vinext could not resolve vite/package.json (${message})`,
    );
  }
}

function getViteMajorVersionFromRequire(require: NodeRequire): number {
  const vitePkg = require("vite/package.json");
  const viteMajor = parseInt(vitePkg?.version, 10);
  if (vitePkg?.name === "vite" && Number.isFinite(viteMajor)) {
    return viteMajor;
  }

  const bundledViteMajor = parseInt(vitePkg?.bundledVersions?.vite, 10);
  if (Number.isFinite(bundledViteMajor)) {
    return bundledViteMajor;
  }

  throw new Error(`could not determine Vite version from ${vitePkg?.name ?? "vite/package.json"}`);
}

function isModuleNotFoundError(error: unknown): boolean {
  return (
    !!error && typeof error === "object" && "code" in error && error.code === "MODULE_NOT_FOUND"
  );
}

export function assertSupportedViteVersion(): number {
  const viteMajorVersion = getViteMajorVersion();
  if (viteMajorVersion < 8) {
    throw new Error(`[vinext] Vite 8 or newer is required. Detected Vite ${viteMajorVersion}.`);
  }
  return viteMajorVersion;
}
