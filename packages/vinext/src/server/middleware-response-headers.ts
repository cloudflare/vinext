const ADDITIVE_RESPONSE_HEADER_NAMES = new Set(["set-cookie", "vary"]);

function mergeVaryHeader(target: Headers, value: string): void {
  const existing = target.get("Vary");
  if (!existing) {
    target.set("Vary", value);
    return;
  }

  const seen = new Set<string>();
  const merged: string[] = [];
  for (const token of `${existing}, ${value}`.split(",")) {
    const trimmed = token.trim();
    if (!trimmed) continue;

    const normalized = trimmed.toLowerCase();
    if (seen.has(normalized)) continue;

    seen.add(normalized);
    merged.push(trimmed);
  }

  target.set("Vary", merged.join(", "));
}

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
    if (key.toLowerCase() === "vary") {
      mergeVaryHeader(target, value);
      continue;
    }

    if (ADDITIVE_RESPONSE_HEADER_NAMES.has(key.toLowerCase())) {
      target.append(key, value);
      continue;
    }

    target.set(key, value);
  }
}
