import { getHeadersContext } from "vinext/shims/headers";
import { normalizeHost, requestContextFromRequest } from "../config/config-matchers.js";
import type { RequestContext } from "../config/config-matchers.js";

/**
 * Build a request context from the live ALS HeadersContext, which reflects
 * any x-middleware-request-* header mutations applied by middleware.
 * Used for afterFiles and fallback rewrite has/missing evaluation — these
 * run after middleware in the App Router execution order.
 *
 * Falls back to `requestContextFromRequest(request)` when no HeadersContext
 * is set (no middleware ran, or middleware didn't set request headers).
 */
export function buildPostMwRequestContext(request: Request): RequestContext {
  const url = new URL(request.url);
  const ctx = getHeadersContext();
  if (!ctx) return requestContextFromRequest(request);
  const cookiesRecord: Record<string, string> = Object.fromEntries(ctx.cookies);
  return {
    headers: ctx.headers,
    cookies: cookiesRecord,
    query: url.searchParams,
    host: normalizeHost(ctx.headers.get("host"), url.hostname),
  };
}
