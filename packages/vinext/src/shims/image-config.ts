import ipaddr from "ipaddr.js";

/**
 * Image remote pattern validation.
 *
 * Validates remote image URLs against the `images.remotePatterns` and
 * `images.domains` config from next.config.js. This prevents SSRF and
 * open-redirect attacks by blocking URLs that don't match any configured
 * pattern.
 *
 * Pattern matching follows Next.js's picomatch semantics:
 * - hostname `*` and `**` can match across dot-separated subdomains
 * - pathname `*` matches one path segment and `**` matches across segments
 * - protocol, port, and search are matched exactly when specified
 */

export type RemotePattern = {
  protocol?: string;
  hostname: string;
  port?: string;
  pathname?: string;
  search?: string;
};

export type RemotePatternInput = RemotePattern | URL | string;

export type LocalPattern = {
  pathname?: string;
  search?: string;
};

export const DEFAULT_LOCAL_PATTERNS: LocalPattern[] = [{ pathname: "**", search: "" }];

export function normalizeLocalPatterns(patterns?: LocalPattern[]): LocalPattern[] {
  if (patterns === undefined) return DEFAULT_LOCAL_PATTERNS;
  const normalized = patterns.map((pattern) => ({ ...pattern }));
  if (
    !normalized.some(
      (pattern) => pattern.pathname === "/_next/static/media/**" && pattern.search === "",
    )
  ) {
    normalized.push({ pathname: "/_next/static/media/**", search: "" });
  }
  return normalized;
}

export function normalizeRemotePattern(pattern: RemotePatternInput): RemotePattern {
  if (typeof pattern === "string" || pattern instanceof URL) {
    const url = typeof pattern === "string" ? new URL(pattern) : pattern;
    return {
      protocol: url.protocol.slice(0, -1),
      hostname: url.hostname,
      port: url.port,
      pathname: url.pathname,
      search: url.search,
    };
  }
  return pattern;
}

export function normalizeRemotePatterns(patterns: RemotePatternInput[]): RemotePattern[] {
  return patterns.map(normalizeRemotePattern);
}

// Cache compiled glob regexes — bounded by the number of distinct configured
// remotePatterns. Key uses \0 as a separator; \0 cannot appear in a valid glob
// or separator character, so there are no collisions. Compiled regexes are
// flagless, so sharing via .test() is safe.
const globRegexCache = new Map<string, RegExp>();

/**
 * Convert a glob pattern (with `*` and `**`) to a RegExp.
 *
 * For hostnames, Next.js uses picomatch without treating `.` as a path
 * separator, so both `*` and `**` can match nested subdomains.
 *
 * For pathnames, segments are separated by `/`:
 *   - `*` matches a single segment (no slashes): [^/]+
 *   - `**` matches any number of segments (including empty): .*
 *
 * Literal characters are escaped for regex safety.
 */
function globToRegex(pattern: string, separator: "." | "/"): RegExp {
  const key = `${separator}\0${pattern}`;
  const cached = globRegexCache.get(key);
  if (cached !== undefined) return cached;
  // Split by ** first, then handle * within each part
  let regexStr = "^";
  const doubleStar = ".*";
  const singleStar = separator === "." ? ".*" : "[^/]+";

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

/**
 * Check whether a URL matches a single remote pattern.
 * Follows the same semantics as Next.js's matchRemotePattern().
 */
export function matchRemotePattern(patternInput: RemotePatternInput, url: URL): boolean {
  const pattern = normalizeRemotePattern(patternInput);
  // Protocol check (strip trailing colon for comparison)
  if (pattern.protocol !== undefined) {
    if (pattern.protocol.replace(/:$/, "") !== url.protocol.replace(/:$/, "")) {
      return false;
    }
  }

  // Port check
  if (pattern.port !== undefined) {
    if (pattern.port !== url.port) {
      return false;
    }
  }

  // Hostname check (required field)
  if (!globToRegex(pattern.hostname, ".").test(url.hostname)) {
    return false;
  }

  // Search/query string check
  if (pattern.search !== undefined) {
    if (pattern.search !== url.search) {
      return false;
    }
  }

  // Pathname check — defaults to ** (match everything) if not specified
  const pathnamePattern = pattern.pathname ?? "**";
  if (!globToRegex(pathnamePattern, "/").test(url.pathname)) {
    return false;
  }

  return true;
}

/**
 * Check whether a URL matches any configured remote pattern or legacy domain.
 */
export function hasRemoteMatch(
  domains: string[],
  remotePatterns: RemotePatternInput[],
  url: URL,
): boolean {
  return (
    domains.some((domain) => url.hostname === domain) ||
    remotePatterns.some((p) => matchRemotePattern(p, url))
  );
}

export function matchLocalPattern(pattern: LocalPattern, url: URL): boolean {
  if (pattern.search !== undefined && pattern.search !== url.search) return false;
  return globToRegex(pattern.pathname ?? "**", "/").test(url.pathname);
}

export function hasLocalMatch(localPatterns: LocalPattern[] | undefined, url: string): boolean {
  const parsedUrl = new URL(url, "http://n");
  return normalizeLocalPatterns(localPatterns).some((pattern) =>
    matchLocalPattern(pattern, parsedUrl),
  );
}

// ─── Private IP detection ───────────────────────────────────────────────

/**
 * Determine whether a string is a private (non-routable) IP address.
 * Works for IPv4 and IPv6, including bracketed and IPv4-mapped forms.
 *
 * Uses ipaddr.js with range() !== 'unicast' — the same approach Next.js
 * takes (via packages/next/src/server/is-private-ip.ts). This covers all
 * IETF non-unicast ranges (CGNAT, benchmarking, multicast, reserved,
 * teredo, documentation, discard, NAT64, etc.) without hand-rolling CIDR
 * prefix checks that are easy to get wrong.
 *
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/server/is-private-ip.ts
 */
export function isPrivateIp(ip: string): boolean {
  // Strip IPv6 brackets so ipaddr.js can parse the raw address.
  if (ip.startsWith("[") && ip.endsWith("]")) {
    ip = ip.slice(1, -1);
  }

  try {
    const parsed = ipaddr.parse(ip);
    // IPv4-mapped addresses are classified as "ipv4Mapped" by ipaddr.js,
    // not "unicast". We must look at the embedded IPv4 address to decide
    // whether it's private (e.g., ::ffff:127.0.0.1) or public.
    if (parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress()) {
      return parsed.toIPv4Address().range() !== "unicast";
    }
    return parsed.range() !== "unicast";
  } catch {
    // Not a valid IP address (e.g., a domain name) — not private.
    return false;
  }
}
