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
type AdditionalData = string | ((source: string, filename: string) => string | Promise<string>);

type VitePreprocessorOptions = {
  additionalData?: AdditionalData;
  loadPaths?: string[];
  // oxlint-disable-next-line typescript/no-explicit-any
  [key: string]: any;
};

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
