const ADDITIVE_RESPONSE_HEADER_NAMES = new Set(["set-cookie", "vary"]);

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
