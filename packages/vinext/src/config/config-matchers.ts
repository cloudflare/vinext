/**
 * Config pattern matching and rule application utilities.
 *
 * Shared between the dev server (index.ts) and the production server
 * (prod-server.ts) so both apply next.config.js rules identically.
 */

import type { NextRedirect, NextRewrite, NextHeader } from "./next-config.js";

/**
 * Match a Next.js config pattern (from redirects/rewrites sources) against a pathname.
 * Returns matched params or null.
 *
 * Supports:
 *   :param     - matches a single path segment
 *   :param*    - matches zero or more segments (catch-all)
 *   :param+    - matches one or more segments
 *   (regex)    - inline regex patterns in the source
 *   :param(constraint) - named param with inline regex constraint
 */
export function matchConfigPattern(
  pathname: string,
  pattern: string,
): Record<string, string> | null {
  // If the pattern contains regex groups like (\d+) or (.*), use regex matching
  if (pattern.includes("(") || pattern.includes("\\")) {
    try {
      const paramNames: string[] = [];
      const regexStr = pattern
        .replace(/\./g, "\\.")
        // :param* with optional constraint
        .replace(/:(\w+)\*(?:\(([^)]+)\))?/g, (_m, name, constraint) => {
          paramNames.push(name);
          return constraint ? `(${constraint})` : "(.*)";
        })
        // :param+ with optional constraint
        .replace(/:(\w+)\+(?:\(([^)]+)\))?/g, (_m, name, constraint) => {
          paramNames.push(name);
          return constraint ? `(${constraint})` : "(.+)";
        })
        // :param(constraint) - named param with inline regex constraint
        .replace(/:(\w+)\(([^)]+)\)/g, (_m, name, constraint) => {
          paramNames.push(name);
          return `(${constraint})`;
        })
        // :param - plain named param
        .replace(/:(\w+)/g, (_m, name) => {
          paramNames.push(name);
          return "([^/]+)";
        });
      const re = new RegExp("^" + regexStr + "$");
      const match = re.exec(pathname);
      if (!match) return null;
      const params: Record<string, string> = {};
      for (let i = 0; i < paramNames.length; i++) {
        params[paramNames[i]] = match[i + 1] ?? "";
      }
      return params;
    } catch {
      // Fall through to segment-based matching
    }
  }

  // Check for catch-all patterns (:param* or :param+) without regex groups
  const catchAllMatch = pattern.match(/:(\w+)(\*|\+)$/);
  if (catchAllMatch) {
    const prefix = pattern.slice(0, pattern.lastIndexOf(":"));
    const paramName = catchAllMatch[1];
    const isPlus = catchAllMatch[2] === "+";

    if (!pathname.startsWith(prefix.replace(/\/$/, ""))) return null;

    const rest = pathname.slice(prefix.replace(/\/$/, "").length);
    if (isPlus && (!rest || rest === "/")) return null;
    return { [paramName]: rest.startsWith("/") ? rest.slice(1) : rest };
  }

  // Simple segment-based matching for exact patterns and :param
  const parts = pattern.split("/");
  const pathParts = pathname.split("/");

  if (parts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].startsWith(":")) {
      params[parts[i].slice(1)] = pathParts[i];
    } else if (parts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

/**
 * Apply redirect rules from next.config.js.
 * Returns the redirect info if a redirect was matched, or null.
 */
export function matchRedirect(
  pathname: string,
  redirects: NextRedirect[],
): { destination: string; permanent: boolean } | null {
  for (const redirect of redirects) {
    const params = matchConfigPattern(pathname, redirect.source);
    if (params) {
      let dest = redirect.destination;
      for (const [key, value] of Object.entries(params)) {
        dest = dest.replace(`:${key}`, value);
      }
      return { destination: dest, permanent: redirect.permanent };
    }
  }
  return null;
}

/**
 * Apply rewrite rules from next.config.js.
 * Returns the rewritten URL or null if no rewrite matched.
 */
export function matchRewrite(
  pathname: string,
  rewrites: NextRewrite[],
): string | null {
  for (const rewrite of rewrites) {
    const params = matchConfigPattern(pathname, rewrite.source);
    if (params) {
      let dest = rewrite.destination;
      for (const [key, value] of Object.entries(params)) {
        dest = dest.replace(`:${key}`, value);
      }
      return dest;
    }
  }
  return null;
}

/**
 * Apply custom header rules from next.config.js.
 * Returns an array of { key, value } pairs to set on the response.
 */
export function matchHeaders(
  pathname: string,
  headers: NextHeader[],
): Array<{ key: string; value: string }> {
  const result: Array<{ key: string; value: string }> = [];
  for (const rule of headers) {
    // Extract regex groups first, process the rest, then restore groups.
    const groups: string[] = [];
    const withPlaceholders = rule.source.replace(/\(([^)]+)\)/g, (_m, inner) => {
      groups.push(inner);
      return `___GROUP_${groups.length - 1}___`;
    });
    const escaped = withPlaceholders
      .replace(/\./g, "\\.")
      .replace(/\+/g, "\\+")
      .replace(/\?/g, "\\?")
      .replace(/\*/g, ".*")
      .replace(/:\w+/g, "[^/]+")
      .replace(/___GROUP_(\d+)___/g, (_m, idx) => `(${groups[Number(idx)]})`);
    const sourceRegex = new RegExp("^" + escaped + "$");
    if (sourceRegex.test(pathname)) {
      result.push(...rule.headers);
    }
  }
  return result;
}
