/**
 * Helpers for parsing Next.js error `digest` strings shared across the App
 * Router execution paths (server actions, page renders, route handlers).
 *
 * Special control flow is encoded as thrown errors carrying a `digest` field.
 * Redirect digests may appear as vinext's encoded three-part form or Next.js's
 * raw, semicolon-terminated form:
 *  - `NEXT_REDIRECT;<type>;<url>[;<status>[;]]` — `redirect()` / `permanentRedirect()`
 *  - `NEXT_NOT_FOUND` — `notFound()`
 *  - `NEXT_HTTP_ERROR_FALLBACK;<status>` — `forbidden()` / `unauthorized()` / etc.
 *
 * Each call site needs slightly different post-processing (URL resolution
 * against the request, 303-vs-307 status overrides for actions, etc.), so
 * these helpers only handle the parsing — callers shape the result.
 */

import { parseRedirectDigest, type RedirectDigest } from "../utils/redirect-digest.js";

type NextRedirectDigest = RedirectDigest;

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
 * Parses redirect digests from vinext's encoded three-part form and Next.js's
 * raw, semicolon-terminated form. Returns null when the digest is not a
 * redirect digest. Vinext's encoded URL is decoded with `decodeURIComponent`;
 * Next.js's canonical raw URL is preserved verbatim. The `status` defaults to
 * 307 when omitted; an omitted `type` is left as null so the caller can apply
 * the correct context-sensitive default.
 */
export function parseNextRedirectDigest(digest: string): NextRedirectDigest | null {
  return parseRedirectDigest(digest);
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
