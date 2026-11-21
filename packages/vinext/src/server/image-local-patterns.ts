/**
 * `images.localPatterns` matching for the image optimization endpoint, kept
 * apart from the remote-pattern shim so the request path doesn't load its IP
 * parsing.
 */

export type LocalPattern = {
  pathname?: string;
  search?: string;
};

const localPathnameRegexCache = new Map<string, RegExp>();

/**
 * Convert a local pathname glob to a RegExp, reading `*` and `**` like Next.js's
 * picomatch (`makeRe(pathname, { dot: true })`):
 *   - a `**` segment matches zero or more whole segments, but needs its own
 *     separator right after a leading `/`, and at the end after a segment
 *     that ends in `*`;
 *   - any other `*` run matches characters within one segment;
 *   - a last segment ending in `*` also matches one trailing slash, and a
 *     whole last `*` matches one character or more (that slash included).
 * Other picomatch syntax (braces, `?`, classes) is matched literally.
 */
function localPathnameGlobToRegex(pattern: string): RegExp {
  const cached = localPathnameRegexCache.get(pattern);
  if (cached !== undefined) return cached;
  // Consecutive `**` segments match like one.
  const segments = pattern
    .split("/")
    .filter((segment, i, all) => !(segment === "**" && all[i - 1] === "**"));
  let regexStr = "^";
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const previous = segments[i - 1];
    const isLast = i === segments.length - 1;
    if (segment === "**") {
      if (i === 0) regexStr += isLast ? ".*" : "(?:.*/)?";
      else if (previous === "" || (isLast && previous.endsWith("*"))) regexStr += "/.*";
      else regexStr += "(?:/.*)?";
      continue;
    }
    // A leading `**` already ends with the separator.
    if (i > 0 && !(i === 1 && previous === "**")) regexStr += "/";
    if (segment === "*" && isLast) {
      regexStr += "(?:[^/]+/?|/)";
      continue;
    }
    regexStr += segment
      .split(/\*+/)
      .map((literal) => literal.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^/]*");
    if (isLast && segment.endsWith("*")) regexStr += "/?";
  }
  regexStr += "$";
  const re = new RegExp(regexStr);
  localPathnameRegexCache.set(pattern, re);
  return re;
}

/**
 * Check whether a local URL matches a single local pattern.
 * Follows the same semantics as Next.js's matchLocalPattern().
 */
export function matchLocalPattern(pattern: LocalPattern, url: URL): boolean {
  if (pattern.search !== undefined && pattern.search !== url.search) {
    return false;
  }
  return localPathnameGlobToRegex(pattern.pathname ?? "**").test(url.pathname);
}

/**
 * Check whether a local URL matches any configured local pattern. Like
 * Next.js's hasLocalMatch(), an unset list allows every local URL.
 */
export function hasLocalMatch(localPatterns: LocalPattern[] | undefined, url: URL): boolean {
  if (!localPatterns) return true;
  return localPatterns.some((p) => matchLocalPattern(p, url));
}
