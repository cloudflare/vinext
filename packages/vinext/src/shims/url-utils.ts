/**
 * Shared URL utilities for same-origin detection.
 *
 * Used by link.tsx, navigation.ts, and router.ts to normalize
 * same-origin absolute URLs to local paths for client-side navigation.
 */
import { hasBasePath, stripBasePath } from "../utils/base-path.js";

// Mirrors Next.js's absolute URL classification:
// packages/next/src/shared/lib/utils.ts
const ABSOLUTE_URL_REGEX = /^[a-zA-Z][a-zA-Z\d+\-.]*?:/;

export function isAbsoluteUrl(url: string): boolean {
  const firstChar = url.charCodeAt(0);
  const startsWithLetter =
    (firstChar >= 65 && firstChar <= 90) || (firstChar >= 97 && firstChar <= 122);

  return startsWithLetter && ABSOLUTE_URL_REGEX.test(url);
}

export function isAbsoluteOrProtocolRelativeUrl(url: string): boolean {
  return isAbsoluteUrl(url) || url.startsWith("//");
}

export function getWindowOrigin(): string | null {
  if (typeof window === "undefined") return null;
  const { origin, href } = window.location;
  if (origin) return origin;
  try {
    return new URL(href).origin;
  } catch {
    return null;
  }
}

/**
 * If `url` is an absolute same-origin URL, return the local path
 * (pathname + search + hash). Returns null for truly external URLs
 * or on the server (where origin is unknown).
 */
export function toSameOriginPath(url: string): string | null {
  const origin = getWindowOrigin();
  if (!origin) return null;
  try {
    const parsed = url.startsWith("//") ? new URL(url, origin) : new URL(url);
    if (parsed.origin === origin) {
      return parsed.pathname + parsed.search + parsed.hash;
    }
  } catch {
    // not a valid absolute URL — ignore
  }
  return null;
}

/**
 * If `url` is an absolute same-origin URL, return the app-relative path
 * (basePath stripped from the pathname, if configured). Returns null for
 * truly external URLs or on the server.
 */
export function toSameOriginAppPath(url: string, basePath: string): string | null {
  const localPath = toSameOriginPath(url);
  if (localPath == null || !basePath) return localPath;

  try {
    const parsed = new URL(localPath, "http://vinext.local");
    if (!hasBasePath(parsed.pathname, basePath)) {
      return null;
    }
    const pathname = stripBasePath(parsed.pathname, basePath);
    return pathname + parsed.search + parsed.hash;
  } catch {
    return localPath;
  }
}

/**
 * Split a path string into pathname, query, and hash without depending on
 * the URL constructor (which would resolve relative paths against an origin).
 *
 * Ported from Next.js: packages/next/src/shared/lib/router/utils/parse-path.ts
 */
function parsePath(path: string): { pathname: string; query: string; hash: string } {
  const hashIndex = path.indexOf("#");
  const queryIndex = path.indexOf("?");
  const hasQuery = queryIndex > -1 && (hashIndex < 0 || queryIndex < hashIndex);

  if (hasQuery || hashIndex > -1) {
    return {
      pathname: path.substring(0, hasQuery ? queryIndex : hashIndex),
      query: hasQuery ? path.substring(queryIndex, hashIndex > -1 ? hashIndex : undefined) : "",
      hash: hashIndex > -1 ? path.slice(hashIndex) : "",
    };
  }

  return { pathname: path, query: "", hash: "" };
}

/**
 * Drop trailing slashes from a route while preserving the bare root.
 *
 * Ported from Next.js: packages/next/src/shared/lib/router/utils/remove-trailing-slash.ts
 */
function removeRouteTrailingSlash(route: string): string {
  return route.replace(/\/$/, "") || "/";
}

/**
 * Normalise the trailing slash of a local URL according to the
 * `trailingSlash` config option in `next.config.js`. Used by the `<Link>`
 * shim so that rendered `href` attributes match the canonical URL form
 * (which is what the server-side redirect would otherwise enforce).
 *
 * Behaviour matches Next.js's client-side `normalizePathTrailingSlash`:
 * packages/next/src/client/normalize-trailing-slash.ts
 *
 * - Absolute URLs (`http://`, `https://`, `//`) and non-local strings are
 *   returned unchanged.
 * - Paths whose final segment looks like a filename (`...\.ext`) have any
 *   trailing slash stripped even when `trailingSlash: true`, mirroring the
 *   `.well-known`-aware redirect rule shipped in `routes-manifest.json`.
 * - Query strings and hash fragments are preserved verbatim.
 * - Idempotent: already-canonical paths round-trip unchanged.
 */
export function normalizePathTrailingSlash(path: string, trailingSlash: boolean): string {
  if (!path.startsWith("/") || path.startsWith("//")) {
    return path;
  }

  const { pathname, query, hash } = parsePath(path);

  if (trailingSlash) {
    if (/\.[^/]+\/?$/.test(pathname)) {
      // Looks like a filename — strip trailing slash even with trailingSlash: true.
      return `${removeRouteTrailingSlash(pathname)}${query}${hash}`;
    }
    if (pathname.endsWith("/")) {
      return `${pathname}${query}${hash}`;
    }
    return `${pathname}/${query}${hash}`;
  }

  return `${removeRouteTrailingSlash(pathname)}${query}${hash}`;
}

/**
 * Prepend basePath to a local path for browser URLs / fetches.
 */
export function withBasePath(path: string, basePath: string): string {
  if (!basePath || !path.startsWith("/") || isAbsoluteOrProtocolRelativeUrl(path)) {
    return path;
  }

  return basePath + path;
}

/**
 * Resolve a potentially relative href against the current URL.
 * Handles: "#hash", "?query", "?query#hash", and relative paths.
 */
export function resolveRelativeHref(href: string, currentUrl?: string, basePath = ""): string {
  const base = currentUrl ?? (typeof window !== "undefined" ? window.location.href : undefined);

  if (!base) return href;

  if (href.startsWith("/") || isAbsoluteOrProtocolRelativeUrl(href)) {
    return href;
  }

  try {
    const resolved = new URL(href, base);
    const pathname =
      basePath && resolved.pathname === basePath
        ? ""
        : basePath
          ? stripBasePath(resolved.pathname, basePath)
          : resolved.pathname;
    return pathname + resolved.search + resolved.hash;
  } catch {
    return href;
  }
}

/**
 * Convert a local navigation target into the browser URL that should be used
 * for history entries, fetches, and onNavigate callbacks.
 */
export function toBrowserNavigationHref(href: string, currentUrl?: string, basePath = ""): string {
  const resolved = resolveRelativeHref(href, currentUrl, basePath);

  if (!basePath) {
    return withBasePath(resolved, basePath);
  }

  if (resolved === "") {
    return basePath;
  }

  if (resolved.startsWith("?") || resolved.startsWith("#")) {
    return basePath + resolved;
  }

  return withBasePath(resolved, basePath);
}

export function isHashOnlyBrowserUrlChange(
  href: string,
  currentHref: string,
  basePath = "",
): boolean {
  try {
    const current = new URL(currentHref);
    const next = new URL(href, currentHref);
    const currentPathname = stripBasePath(current.pathname, basePath);
    const nextPathname = stripBasePath(next.pathname, basePath);
    return currentPathname === nextPathname && current.search === next.search && next.hash !== "";
  } catch {
    return false;
  }
}
