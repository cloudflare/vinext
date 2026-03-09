/**
 * Shared URL utilities for same-origin detection.
 *
 * Used by link.tsx, navigation.ts, and router.ts to normalize
 * same-origin absolute URLs to local paths for client-side navigation.
 */

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
