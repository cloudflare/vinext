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
 * Detect the Vite toolchain version at runtime. Prefer the project cwd, then
 * fall back to vinext's own dependency graph for tests and linked checkouts.
 */
type ViteToolchainVersion = {
  vite: string;
  rolldown?: string;
};

function getViteToolchainVersion(): ViteToolchainVersion {
  try {
    return getViteToolchainVersionFromRequire(
      createRequire(path.join(process.cwd(), "package.json")),
    );
  } catch (error) {
    if (!isModuleNotFoundError(error)) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`[vinext] Vite 8 or newer is required, but ${message}`);
    }
  }

  try {
    return getViteToolchainVersionFromRequire(createRequire(import.meta.url));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `[vinext] Vite 8 or newer is required, but vinext could not resolve vite/package.json (${message})`,
    );
  }
}

function getViteToolchainVersionFromRequire(require: NodeRequire): ViteToolchainVersion {
  const vitePkg = require("vite/package.json");
  if (vitePkg?.name === "vite" && parseViteVersion(vitePkg.version)) {
    return { vite: vitePkg.version };
  }

  const bundledViteVersion = vitePkg?.bundledVersions?.vite;
  if (parseViteVersion(bundledViteVersion)) {
    const bundledRolldownVersion = vitePkg?.bundledVersions?.rolldown;
    return {
      vite: bundledViteVersion,
      rolldown: parseViteVersion(bundledRolldownVersion) ? bundledRolldownVersion : undefined,
    };
  }

  throw new Error(`could not determine Vite version from ${vitePkg?.name ?? "vite/package.json"}`);
}

function parseViteVersion(
  version: unknown,
): [major: number, minor: number, patch: number, prerelease: boolean] | null {
  if (typeof version !== "string") return null;
  const match = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3]), !!match[4]];
}

function isModuleNotFoundError(error: unknown): boolean {
  return (
    !!error && typeof error === "object" && "code" in error && error.code === "MODULE_NOT_FOUND"
  );
}

export function supportsNativeTypeofWindowFolding(
  viteVersion: string,
  bundledRolldownVersion?: string,
): boolean {
  if (bundledRolldownVersion !== undefined) {
    return isVersionAtLeast(bundledRolldownVersion, 1, 1, 4);
  }
  return isVersionAtLeast(viteVersion, 8, 1, 4);
}

function isVersionAtLeast(
  version: string,
  requiredMajor: number,
  requiredMinor: number,
  requiredPatch: number,
): boolean {
  const parsedVersion = parseViteVersion(version);
  if (!parsedVersion) return false;
  const [major, minor, patch, prerelease] = parsedVersion;
  if (major !== requiredMajor) return major > requiredMajor;
  if (minor !== requiredMinor) return minor > requiredMinor;
  if (patch !== requiredPatch) return patch > requiredPatch;
  return !prerelease;
}

export function assertSupportedViteVersion(): {
  supportsNativeTypeofWindowFolding: boolean;
} {
  const toolchainVersion = getViteToolchainVersion();
  const [major] = parseViteVersion(toolchainVersion.vite)!;
  if (major < 8) {
    throw new Error(`[vinext] Vite 8 or newer is required. Detected Vite ${major}.`);
  }
  return {
    supportsNativeTypeofWindowFolding: supportsNativeTypeofWindowFolding(
      toolchainVersion.vite,
      toolchainVersion.rolldown,
    ),
  };
}
