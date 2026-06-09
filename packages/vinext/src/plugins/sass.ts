/**
 * Map a Next.js `sassOptions` object onto Vite's
 * `css.preprocessorOptions.scss` / `.sass` shape.
 *
 * Next.js (webpack + sass-loader) accepts:
 * - `additionalData` (or legacy `prependData`) — prepended to every source
 * - `includePaths` — directories searched by `@import`
 * - `loadPaths`    — modern Sass equivalent of `includePaths`
 * - `implementation` — Sass implementation package name (e.g. `sass-embedded`)
 * - other Sass options that get forwarded as-is
 *
 * Reference (Next.js source — destructures the same keys before forwarding
 * the rest to sass-loader):
 *   .nextjs-ref/packages/next/src/build/webpack/config/blocks/css/index.ts#L150-L180
 *   https://github.com/vercel/next.js/blob/canary/packages/next/src/build/webpack/config/blocks/css/index.ts
 *
 * Vite expects:
 * - `additionalData` (string or function) on the preprocessor options
 * - modern Sass options (`loadPaths`, `importers`, `implementation`, …)
 *   flattened next to `additionalData`
 *
 * @see https://vite.dev/config/shared-options.html#css-preprocessoroptions
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import { createRequire } from "node:module";

type AdditionalData = string | ((source: string, filename: string) => string | Promise<string>);

type VitePreprocessorOptions = {
  additionalData?: AdditionalData;
  loadPaths?: string[];
  // oxlint-disable-next-line typescript/no-explicit-any
  [key: string]: any;
};

/**
 * Create a Sass `FileImporter` that resolves webpack-style tilde (`~`) imports.
 *
 * Next.js (via sass-loader's `webpackImporter`) supports two tilde forms:
 *
 * 1. `~pkg/path` — resolves `pkg/path` from `node_modules`. Used for
 *    third-party SCSS/CSS, e.g. `@import '~nprogress/nprogress.css'`.
 *
 * 2. `~/path` — resolves relative to the **project root** (the `~` acts as
 *    an alias for the root). Used with Turbopack's `resolveAlias: { '~*': '*' }`
 *    convention, e.g. `@use '~/styles/variables' as *`.
 *
 * Vite's built-in Sass resolver does not strip the `~` prefix, so any SCSS
 * that uses tilde imports fails with "Can't find stylesheet to import" errors.
 * This `FileImporter` runs before Vite's internal importer (added at the end
 * of `importers[]` in the vite:css plugin) and canonicalises tilde URLs so
 * Sass can load them from the filesystem.
 *
 * The returned object implements the modern Sass `FileImporter` interface:
 * `findFileUrl` returns a `file://` URL and Sass automatically handles partial
 * resolution (`_variables.scss` for `variables`), index files, and extensions.
 *
 * @param root - Absolute path to the Vite project root (used as the base for
 *   `~/path` resolution and for locating `node_modules`).
 */
export function createSassTildeImporter(root: string): { findFileUrl(url: string): URL | null } {
  // Base URL for root-relative (~/) imports. Must end with "/" so new URL()
  // treats it as a directory and resolves relative paths correctly.
  const rootBaseUrl = pathToFileURL(root.endsWith("/") ? root : root + "/");

  // Base URL for node_modules imports. The trailing "/" is critical for
  // new URL(spec, base) to keep the spec as a relative path inside the dir.
  const nodeModulesBaseUrl = pathToFileURL(path.join(root, "node_modules") + "/");

  return {
    findFileUrl(url: string): URL | null {
      if (!url.startsWith("~")) return null;

      const stripped = url.slice(1); // Remove the leading "~"

      if (stripped.startsWith("/")) {
        // Form: ~/path/to/file  →  root-relative
        // stripped = "/path/to/file", we want "<root>/path/to/file"
        // Slice the leading "/" to make it a relative-to-base URL.
        return new URL(stripped.slice(1), rootBaseUrl);
      }

      if (!stripped) {
        // Bare "~" with nothing after it — not a valid import, skip.
        return null;
      }

      // Form: ~pkg/path  →  node_modules resolution
      // Try the simple path first: root/node_modules/pkg/path
      const simpleResolved = new URL(stripped, nodeModulesBaseUrl);

      // Verify the package directory exists in root's node_modules before
      // returning; if not found there, fall back to Node.js module resolution
      // which walks up the directory tree (handles hoisted pnpm graphs, etc.).
      const pkgName = stripped.startsWith("@")
        ? stripped.split("/").slice(0, 2).join("/")
        : (stripped.split("/")[0] ?? "");

      const directPkgDir = path.join(root, "node_modules", pkgName);
      if (pkgName && fs.existsSync(directPkgDir)) {
        // Fast path: package is at root/node_modules/<pkg>
        return simpleResolved;
      }

      // Slow path: use Node.js module resolution to locate the package.
      // This handles pnpm's virtual store layout, yarn PnP, and workspaces
      // where packages aren't necessarily at <root>/node_modules/<pkg>.
      const req = createRequire(path.join(root, "package.json"));
      try {
        const pkgJsonPath = req.resolve(`${pkgName}/package.json`);
        const pkgDir = path.dirname(pkgJsonPath);
        // Build the URL by replacing the package-name segment with the
        // resolved absolute package directory path.
        const afterPkg = stripped.startsWith("@")
          ? stripped.split("/").slice(2).join("/")
          : stripped.split("/").slice(1).join("/");
        const resolvedPath = afterPkg ? path.join(pkgDir, afterPkg) : pkgDir;
        return pathToFileURL(resolvedPath);
      } catch {
        // Package not found via Node.js resolution either — let Sass/Vite's
        // default resolver handle (or report an error for) this import.
        return null;
      }
    },
  };
}

export function buildSassPreprocessorOptions(
  sassOptions: Record<string, unknown> | null | undefined,
): VitePreprocessorOptions | undefined {
  if (!sassOptions || typeof sassOptions !== "object") return undefined;

  const {
    prependData,
    additionalData,
    includePaths,
    loadPaths,
    // oxlint-disable-next-line typescript/no-explicit-any
    ...rest
  } = sassOptions as Record<string, unknown>;

  const out: VitePreprocessorOptions = { ...rest };

  // Next.js forwards `sassPrependData || sassAdditionalData` to sass-loader's
  // `additionalData` (truthy-OR, see
  // .nextjs-ref/packages/next/src/build/webpack/config/blocks/css/index.ts:178),
  // so falsy values like `prependData: ""` fall through to `additionalData`.
  // Mirror that precedence exactly so users migrating from Next.js 12
  // (`prependData`) continue to work.
  const data = prependData || additionalData;
  if (typeof data === "string" || typeof data === "function") {
    out.additionalData = data as AdditionalData;
  }

  // Merge legacy `includePaths` into modern `loadPaths`. Modern Sass dropped
  // `includePaths` in favour of `loadPaths`; Vite uses the modern API, so we
  // alias for users who still configure the legacy name.
  const mergedLoadPaths: string[] = [];
  if (Array.isArray(loadPaths)) {
    for (const p of loadPaths) if (typeof p === "string") mergedLoadPaths.push(p);
  }
  if (Array.isArray(includePaths)) {
    for (const p of includePaths) if (typeof p === "string") mergedLoadPaths.push(p);
  }
  if (mergedLoadPaths.length > 0) {
    out.loadPaths = mergedLoadPaths;
  }

  // If nothing useful was extracted, signal "no override needed" so callers
  // can skip injecting an empty preprocessorOptions object.
  if (Object.keys(out).length === 0) return undefined;

  return out;
}
