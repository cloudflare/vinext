/**
 * Image remote pattern validation.
 *
 * Validates remote image URLs against the `images.remotePatterns` and
 * `images.domains` config from next.config.js. This prevents SSRF and
 * open-redirect attacks by blocking URLs that don't match any configured
 * pattern.
 *
 * Pattern matching follows Next.js semantics:
 * - `*` matches a single segment (subdomain in hostname, path segment in pathname)
 * - `**` matches any number of segments
 * - protocol, port, and search are matched exactly when specified
 */

export type RemotePattern = {
  protocol?: string;
  hostname: string;
  port?: string;
  pathname?: string;
  search?: string;
};

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
 *
 * Literal characters are escaped for regex safety.
 */
function globToRegex(pattern: string, separator: "." | "/"): RegExp {
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
  return new RegExp(regexStr);
}

/**
 * Check whether a URL matches a single remote pattern.
 * Follows the same semantics as Next.js's matchRemotePattern().
 */
export function matchRemotePattern(pattern: RemotePattern, url: URL): boolean {
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
  remotePatterns: RemotePattern[],
  url: URL,
): boolean {
  return (
    domains.some((domain) => url.hostname === domain) ||
    remotePatterns.some((p) => matchRemotePattern(p, url))
  );
}

// ─── Private IP detection ───────────────────────────────────────────────

/**
 * Parse an IPv4 address string into 4 numeric octets.
 * Supports dotted decimal, octal (leading 0), hex (0x prefix),
 * and single-number 32-bit notation.
 */
function parseIPv4(ip: string): number[] | null {
  if (ip.includes(".")) {
    const parts = ip.split(".");
    if (parts.length !== 4) return null;
    const nums = parts.map((p) => {
      if (p === "") return NaN;
      if (p.startsWith("0x") || p.startsWith("0X")) return parseInt(p.slice(2), 16);
      if (p.length > 1 && p.startsWith("0")) return parseInt(p, 8);
      return parseInt(p, 10);
    });
    if (nums.some(isNaN)) return null;
    if (nums.some((n) => n < 0 || n > 255)) return null;
    return nums;
  }

  // Single-number notation (hex or decimal)
  let num: number;
  if (ip.startsWith("0x") || ip.startsWith("0X")) {
    num = parseInt(ip.slice(2), 16);
  } else {
    num = parseInt(ip, 10);
  }
  if (isNaN(num) || num < 0 || num > 0xffffffff) return null;
  return [(num >>> 24) & 0xff, (num >>> 16) & 0xff, (num >>> 8) & 0xff, num & 0xff];
}

function isPrivateIPv4(parts: number[]): boolean {
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8
  if (a === 169 && b === 254) return true; // 169.254.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  if (ip === "::1" || ip === "::") return true;

  const lower = ip.toLowerCase();

  // fc00::/7 (unique local)
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  // fe80::/10 (link-local)
  if (
    lower.startsWith("fe8") ||
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb")
  )
    return true;
  // ff00::/8 (multicast)
  if (lower.startsWith("ff")) return true;
  // 2001:2f::/32 (benchmarking)
  if (lower.startsWith("2001:2f:")) return true;
  // 2002::/16 (6to4)
  if (lower.startsWith("2002:")) return true;

  return false;
}

/**
 * Determine whether a string is a private (non-routable) IP address.
 * Works for IPv4 and IPv6, including bracketed and IPv4-mapped forms.
 *
 * Ported from Next.js: packages/next/src/server/is-private-ip.ts
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/server/is-private-ip.ts
 */
export function isPrivateIp(ip: string): boolean {
  if (ip.startsWith("[") && ip.endsWith("]")) {
    ip = ip.slice(1, -1);
  }

  // IPv4-mapped IPv6 addresses (::ffff:...)
  const lowerIp = ip.toLowerCase();
  if (lowerIp.startsWith("::ffff:")) {
    const mapped = ip.slice(7);
    if (mapped.includes(".")) {
      const ipv4 = parseIPv4(mapped);
      if (ipv4 && isPrivateIPv4(ipv4)) return true;
    } else if (mapped.includes(":")) {
      // Two hex groups like 7f00:1
      const parts = mapped.split(":");
      if (parts.length === 2) {
        const hi = parseInt(parts[0], 16);
        const lo = parseInt(parts[1], 16);
        if (!isNaN(hi) && !isNaN(lo)) {
          return isPrivateIPv4([(hi >>> 8) & 0xff, hi & 0xff, (lo >>> 8) & 0xff, lo & 0xff]);
        }
      }
    }
  }

  if (ip.includes(":")) {
    return isPrivateIPv6(ip);
  }

  const ipv4 = parseIPv4(ip);
  if (ipv4) {
    return isPrivateIPv4(ipv4);
  }

  return false;
}
