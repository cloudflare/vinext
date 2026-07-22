/**
 * Normalize the `x-vinext-interception-context` header from inbound requests.
 *
 * The browser sends the current pathname (e.g. `/feed`) as interception context
 * so the server can decide whether to render an intercepted parallel route.
 * The legitimate value is always a same-origin URL pathname produced by the
 * vinext browser entry — never an arbitrary string.
 *
 * Security: this value flows into cache-key construction (via
 * `getOptimisticRouteTemplateKey`, `getOptimisticPrefetchSourceKey`, and
 * outbound RSC payload cache keys). Without bounds, an attacker who controls
 * this header can fabricate unbounded distinct values to fragment the cache
 * or drive per-write KV billing. See `SECURITY-AUDIT-2026-05.md` finding
 * F-PROD-1.
 *
 * Bounds applied:
 *   - Null bytes are stripped (header-injection defense).
 *   - The value must start with `/` (a pathname).
 *   - Whitespace is rejected (real pathnames do not contain raw whitespace;
 *     legitimate spaces would be percent-encoded).
 *   - Length capped at MAX_INTERCEPTION_CONTEXT_LENGTH bytes. Values that
 *     exceed the cap are treated as absent so the request is still served,
 *     just without interception.
 *
 * Anything that fails validation returns null, matching the prior behavior of
 * an absent header. This is intentionally more permissive than rejecting the
 * whole request — interception is a progressive enhancement.
 */

/** Hard cap on the byte length of the interception-context header value. */
const MAX_INTERCEPTION_CONTEXT_LENGTH = 1024;

export function normalizeInterceptionContextHeader(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // Strip null bytes first so length bounds can't be evaded by padding with \0.
  const stripped = raw.replaceAll("\0", "");
  if (stripped.length === 0) return null;
  if (stripped.length > MAX_INTERCEPTION_CONTEXT_LENGTH) return null;
  // Must look like a same-origin pathname. Anything else (a full URL, a token,
  // junk bytes) is not a legitimate value the browser would emit.
  if (!stripped.startsWith("/")) return null;
  // Raw whitespace is not legitimate inside a pathname.
  if (/\s/.test(stripped)) return null;
  return stripped;
}
