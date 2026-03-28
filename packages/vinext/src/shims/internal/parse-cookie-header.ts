/**
 * Port of the current Next.js/@edge-runtime request cookie parser semantics.
 *
 * Important details:
 * - split on a semicolon-plus-optional-spaces pattern
 * - preserve whitespace around names/values otherwise
 * - bare tokens become "true"
 * - malformed percent-encoded values are skipped
 * - duplicate names collapse to the last value via Map.set()
 */
export function parseCookieHeader(cookieHeader: string): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const pair of cookieHeader.split(/; */)) {
    if (!pair) continue;

    const splitAt = pair.indexOf("=");
    if (splitAt === -1) {
      cookies.set(pair, "true");
      continue;
    }

    const key = pair.slice(0, splitAt);
    const value = pair.slice(splitAt + 1);

    try {
      cookies.set(key, decodeURIComponent(value));
    } catch {
      // Match Next.js/@edge-runtime behavior: ignore malformed cookie values.
    }
  }
  return cookies;
}
