// Shared digest-classification helpers for App Router "navigation signal"
// errors — the ones thrown via redirect(), notFound(), forbidden(), and
// unauthorized(). These have framework-recognized digests of the form
// `NEXT_REDIRECT;...`, `NEXT_NOT_FOUND`, or `NEXT_HTTP_ERROR_FALLBACK;<status>`
// and must be re-thrown by user-facing error boundaries (so they reach the
// dedicated framework boundary that handles them) and filtered out of the
// dev error overlay (so a caught redirect doesn't show up as a runtime
// error).
//
// Previously duplicated between shims/error-boundary.tsx and
// client/dev-error-overlay.tsx; consolidated here so they cannot drift.

import { parseRedirectDigest } from "./redirect-digest.js";

const HTTP_ACCESS_FALLBACK_STATUSES = new Set([401, 403, 404]);

function getErrorDigest(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("digest" in error)) {
    return null;
  }
  return String((error as { digest: unknown }).digest);
}

export function isNavigationSignalError(error: unknown): boolean {
  const digest = getErrorDigest(error);
  if (digest === null) return false;
  return (
    digest === "NEXT_NOT_FOUND" ||
    digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;") ||
    digest.startsWith("NEXT_REDIRECT;")
  );
}

export function isValidNavigationSignalError(error: unknown): boolean {
  if (
    !error ||
    typeof error !== "object" ||
    !("digest" in error) ||
    typeof error.digest !== "string"
  ) {
    return false;
  }
  const digest = error.digest;
  if (digest === "NEXT_NOT_FOUND") return true;
  const [code, status] = digest.split(";");
  if (code === "NEXT_HTTP_ERROR_FALLBACK" && HTTP_ACCESS_FALLBACK_STATUSES.has(Number(status))) {
    return true;
  }

  const redirect = parseRedirectDigest(digest);
  return (
    redirect !== null &&
    (redirect.type === null || redirect.type === "push" || redirect.type === "replace")
  );
}
