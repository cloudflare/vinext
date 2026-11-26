// vite-plugin-commonjs wraps each block it adds to a converted module in a
// pair of these marker comments.
const TAG = "[vite-plugin-commonjs]";

/** Opens the export facade the plugin appends after the module's code. */
export const EXPORT_FACADE_START = `/* ${TAG} export-statement-S */`;
/** Closes the export facade the plugin appends after the module's code. */
export const EXPORT_FACADE_END = `/* ${TAG} export-statement-E */`;

// The blocks the plugin prepends, in the order they end up: it prepends the
// hoisted imports first, then the `module` / `exports` polyfill, then the
// require-to-import rewrites, each at most once.
const PREPENDED_BLOCK_NAMES = ["import-require2import", "export-runtime", "import-hoist"];

/** Matches code that starts with a block the plugin prepends. */
export const PREPENDED_BLOCK_START_RE =
  /^\/\* \[vite-plugin-commonjs\] (?:import-require2import|export-runtime|import-hoist)-S \*\//;

/**
 * End offset of the blocks vite-plugin-commonjs prepended to `code`, or 0.
 * Only the plugin's own blocks count, in the order and number it generates
 * them, so a marker-like comment from the module's source is never taken for
 * one.
 */
export function commonJsPrependedBlocksEnd(code: string): number {
  let end = 0;
  for (const name of PREPENDED_BLOCK_NAMES) {
    if (!code.startsWith(`/* ${TAG} ${name}-S */`, end)) continue;
    const close = `/* ${TAG} ${name}-E */`;
    const closeAt = code.indexOf(close, end);
    if (closeAt === -1) return end;
    end = closeAt + close.length;
  }
  return end;
}
