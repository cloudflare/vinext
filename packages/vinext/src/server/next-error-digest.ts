/**
 * Helpers for parsing Next.js error `digest` strings shared across the App
 * Router execution paths (server actions, page renders, route handlers).
 *
 * Next.js encodes special control flow as thrown errors carrying a `digest`
 * field with one of these formats:
 *  - `NEXT_REDIRECT;<type>;<encodedUrl>;<status>` — `redirect()` / `permanentRedirect()`
 *  - `NEXT_NOT_FOUND` — `notFound()`
 *  - `NEXT_HTTP_ERROR_FALLBACK;<status>` — `forbidden()` / `unauthorized()` / etc.
 *
 * Each call site needs slightly different post-processing (URL resolution
 * against the request, 303-vs-307 status overrides for actions, etc.), so
 * these helpers only handle the parsing — callers shape the result.
 */

type NextRedirectDigest = {
  status: number;
  type: string;
  url: string;
};

type NextHttpErrorDigest = {
  status: number;
};

/**
 * Pulls a stringified `digest` off an unknown thrown value, or returns null
 * when the value is not a digest-bearing error.
 */
export function getNextErrorDigest(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("digest" in error)) {
    return null;
  }

  return String(error.digest);
}

/**
 * Parses a `NEXT_REDIRECT;<type>;<encodedUrl>;<status>` digest. Returns null
 * when the digest is not a redirect digest or the encoded URL segment is
 * missing. The `url` is decoded with `decodeURIComponent`; the `status`
 * defaults to 307 when omitted; the `type` defaults to "push".
 */
export function parseNextRedirectDigest(digest: string): NextRedirectDigest | null {
  if (!digest.startsWith("NEXT_REDIRECT;")) {
    return null;
  }

  const parts = digest.split(";");
  const encodedUrl = parts[2];
  if (!encodedUrl) {
    return null;
  }

  return {
    status: parts[3] ? parseInt(parts[3], 10) : 307,
    type: parts[1] || "push",
    url: decodeURIComponent(encodedUrl),
  };
}

/**
 * Parses a `NEXT_NOT_FOUND` or `NEXT_HTTP_ERROR_FALLBACK;<status>` digest.
 * Returns `{ status: 404 }` for `NEXT_NOT_FOUND` and the parsed status code
 * for the fallback form. Returns null otherwise.
 */
export function parseNextHttpErrorDigest(digest: string): NextHttpErrorDigest | null {
  if (digest === "NEXT_NOT_FOUND") {
    return { status: 404 };
  }
  if (digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;")) {
    return { status: parseInt(digest.split(";")[1], 10) };
  }
  return null;
}
