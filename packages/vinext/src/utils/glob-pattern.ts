/**
 * Glob-to-RegExp conversion shared by image remote-pattern (hostname) and
 * local-pattern (pathname) matching. Follows Next.js semantics:
 * - `*` matches a single segment (no separator)
 * - `**` matches any number of segments
 *
 * Literal characters are escaped for regex safety.
 */

// Cache compiled glob regexes — bounded by the number of distinct configured
// patterns. Key uses \0 as a separator; \0 cannot appear in a valid glob or
// separator character, so there are no collisions. Compiled regexes are
// flagless, so sharing via .test() is safe.
const globRegexCache = new Map<string, RegExp>();

/**
 * Convert a glob pattern (with `*` and `**`) to a RegExp.
 *
 * For hostnames, segments are separated by `.`:
 *   - `*` matches a single segment (no dots): [^.]+
 *   - `**` matches any number of segments: .+
 *
 * For pathnames, segments are separated by `/`:
 *   - `*` matches a single segment (no slashes): [^/]+
 *   - `**` matches any number of segments (including empty): .*
 */
export function globToRegex(pattern: string, separator: "." | "/"): RegExp {
  const key = `${separator}\0${pattern}`;
  const cached = globRegexCache.get(key);
  if (cached !== undefined) return cached;
  // Split by ** first, then handle * within each part
  let regexStr = "^";
  const doubleStar = separator === "." ? ".+" : ".*";
  const singleStar = separator === "." ? "[^.]+" : "[^/]+";

  const parts = pattern.split("**");
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) {
      regexStr += doubleStar;
    }
    // Within each part, split by * and escape the literals
    const subParts = parts[i].split("*");
    for (let j = 0; j < subParts.length; j++) {
      if (j > 0) {
        regexStr += singleStar;
      }
      // Escape regex special chars in the literal portion
      regexStr += subParts[j].replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  regexStr += "$";
  const re = new RegExp(regexStr);
  globRegexCache.set(key, re);
  return re;
}
