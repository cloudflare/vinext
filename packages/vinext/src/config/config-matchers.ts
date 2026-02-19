/**
 * Config pattern matching and rule application utilities.
 *
 * Shared between the dev server (index.ts) and the production server
 * (prod-server.ts) so both apply next.config.js rules identically.
 */

import type { NextRedirect, NextRewrite, NextHeader, HasCondition } from "./next-config.js";

/**
 * Request context needed for evaluating has/missing conditions.
 * Callers extract the relevant parts from the incoming Request.
 */
export interface RequestContext {
  headers: Headers;
  cookies: Record<string, string>;
  query: URLSearchParams;
  host: string;
}

/**
 * Parse a Cookie header string into a key-value record.
 */
export function parseCookies(cookieHeader: string | null): Record<string, string> {
  if (!cookieHeader) return {};
  const cookies: Record<string, string> = {};
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key) cookies[key] = value;
  }
  return cookies;
}

/**
 * Build a RequestContext from a Web Request object.
 */
export function requestContextFromRequest(request: Request): RequestContext {
  const url = new URL(request.url);
  return {
    headers: request.headers,
    cookies: parseCookies(request.headers.get("cookie")),
    query: url.searchParams,
    host: request.headers.get("host") ?? url.host,
  };
}

/**
 * Check a single has/missing condition against request context.
 * Returns true if the condition is satisfied.
 */
function checkSingleCondition(condition: HasCondition, ctx: RequestContext): boolean {
  switch (condition.type) {
    case "header": {
      const headerValue = ctx.headers.get(condition.key);
      if (headerValue === null) return false;
      if (condition.value !== undefined) {
        // If value is a regex pattern, test it; otherwise exact match
        try {
          return new RegExp(condition.value).test(headerValue);
        } catch {
          return headerValue === condition.value;
        }
      }
      return true; // Key exists, no value constraint
    }
    case "cookie": {
      const cookieValue = ctx.cookies[condition.key];
      if (cookieValue === undefined) return false;
      if (condition.value !== undefined) {
        try {
          return new RegExp(condition.value).test(cookieValue);
        } catch {
          return cookieValue === condition.value;
        }
      }
      return true;
    }
    case "query": {
      const queryValue = ctx.query.get(condition.key);
      if (queryValue === null) return false;
      if (condition.value !== undefined) {
        try {
          return new RegExp(condition.value).test(queryValue);
        } catch {
          return queryValue === condition.value;
        }
      }
      return true;
    }
    case "host": {
      if (condition.value !== undefined) {
        try {
          return new RegExp(condition.value).test(ctx.host);
        } catch {
          return ctx.host === condition.value;
        }
      }
      return ctx.host === condition.key;
    }
    default:
      return false;
  }
}

/**
 * Check all has/missing conditions for a config rule.
 * Returns true if the rule should be applied (all has conditions pass, all missing conditions pass).
 *
 * - has: every condition must match (the request must have it)
 * - missing: every condition must NOT match (the request must not have it)
 */
export function checkHasConditions(
  has: HasCondition[] | undefined,
  missing: HasCondition[] | undefined,
  ctx: RequestContext,
): boolean {
  if (has) {
    for (const condition of has) {
      if (!checkSingleCondition(condition, ctx)) return false;
    }
  }
  if (missing) {
    for (const condition of missing) {
      if (checkSingleCondition(condition, ctx)) return false;
    }
  }
  return true;
}

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
 *
 * When `ctx` is provided, has/missing conditions on the redirect rules
 * are evaluated against the request context (cookies, headers, query, host).
 */
export function matchRedirect(
  pathname: string,
  redirects: NextRedirect[],
  ctx?: RequestContext,
): { destination: string; permanent: boolean } | null {
  for (const redirect of redirects) {
    const params = matchConfigPattern(pathname, redirect.source);
    if (params) {
      // Check has/missing conditions if present and context is available
      if (ctx && (redirect.has || redirect.missing)) {
        if (!checkHasConditions(redirect.has, redirect.missing, ctx)) {
          continue;
        }
      }
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
 *
 * When `ctx` is provided, has/missing conditions on the rewrite rules
 * are evaluated against the request context (cookies, headers, query, host).
 */
export function matchRewrite(
  pathname: string,
  rewrites: NextRewrite[],
  ctx?: RequestContext,
): string | null {
  for (const rewrite of rewrites) {
    const params = matchConfigPattern(pathname, rewrite.source);
    if (params) {
      // Check has/missing conditions if present and context is available
      if (ctx && (rewrite.has || rewrite.missing)) {
        if (!checkHasConditions(rewrite.has, rewrite.missing, ctx)) {
          continue;
        }
      }
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
