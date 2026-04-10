const ADDITIVE_RESPONSE_HEADER_NAMES = new Set(["set-cookie", "vary"]);

/**
 * Merge middleware response headers into a target Headers object.
 *
 * Set-Cookie and Vary are accumulated (append) since multiple sources can
 * contribute values. All other headers use set() so middleware owns singular
 * response headers like Cache-Control.
 */
export function mergeMiddlewareResponseHeaders(
  target: Headers,
  middlewareHeaders: Headers | null,
): void {
  if (!middlewareHeaders) {
    return;
  }

  for (const [key, value] of middlewareHeaders) {
    if (ADDITIVE_RESPONSE_HEADER_NAMES.has(key.toLowerCase())) {
      target.append(key, value);
      continue;
    }

    target.set(key, value);
  }
}
