/**
 * Source-masking helpers shared by the CJS-global shim plugins.
 *
 * Both the `next.config.ts` injector (`config/next-config.ts`) and the
 * `node_modules` shim (`plugins/cjs-globals-shim.ts`) need to scan source
 * code for bare identifier references / declarations *without* matching
 * tokens that happen to appear inside string literals, template literals,
 * or comments. They originally inlined the same regex; this module owns
 * the canonical version so the two callers cannot drift apart.
 */

/**
 * Single alternation that captures (and consumes) each kind of span we
 * want to ignore. Order matters: the block-comment branch must come
 * before the line-comment branch so `/* ... *\/` containing `//` is
 * matched as one block, and string-literal branches must consume the
 * full literal so embedded `*\/` or `//` don't terminate the wrong span.
 *
 * Template literals are matched segment-by-segment, stopping before
 * `${` so the interpolation contents themselves remain visible to the
 * scan (`__dirname` inside `${__dirname}/views` is a real reference).
 */
const MASK_REGEX =
  /\/\*[\s\S]*?\*\/|\/\/[^\n]*|`(?:[^`\\$]|\\.|\$(?!\{))*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;

/**
 * Replace strings, template literals, and comments in `source` with an
 * equal-length run of spaces. Preserves byte/character offsets so the
 * returned string can be scanned with regexes whose match indices line up
 * with positions in the original source — useful when callers later need
 * to extract surrounding context (e.g. statement boundaries).
 *
 * Template-literal *expressions* (`${...}`) remain visible after masking
 * because the regex stops before `${`. Identifiers used inside an
 * interpolation are real references and must not be hidden.
 */
export function maskStringsAndComments(source: string): string {
  return source.replace(MASK_REGEX, (m) => " ".repeat(m.length));
}
