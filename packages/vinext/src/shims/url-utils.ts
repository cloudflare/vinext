/**
 * Shared URL utilities for same-origin detection.
 *
 * Used by link.tsx, navigation.ts, and router.ts to normalize
 * same-origin absolute URLs to local paths for client-side navigation.
 */
import { hasBasePath, stripBasePath } from "../utils/base-path.js";

/**
 * If `url` is an absolute same-origin URL, return the local path
 * (pathname + search + hash). Returns null for truly external URLs
 * or on the server (where origin is unknown).
 */
export function toSameOriginPath(url: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    const parsed = url.startsWith("//") ? new URL(url, window.location.origin) : new URL(url);
    if (parsed.origin === window.location.origin) {
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
 * Prepend basePath to a local path for browser URLs / fetches.
 */
export function withBasePath(path: string, basePath: string): string {
  if (
    !basePath ||
    !path.startsWith("/") ||
    path.startsWith("http://") ||
    path.startsWith("https://") ||
    path.startsWith("//")
  ) {
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

  if (
    href.startsWith("/") ||
    href.startsWith("http://") ||
    href.startsWith("https://") ||
    href.startsWith("//")
  ) {
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
