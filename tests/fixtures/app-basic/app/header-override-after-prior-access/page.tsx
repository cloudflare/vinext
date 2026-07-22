import { cookies, headers } from "next/headers";

/**
 * Regression test page for a bug where a middleware that reads `headers()`
 * before applying a request-header override leaks its pre-override view into
 * the Server Component.
 *
 * The matching middleware branch does two things, in order:
 *   1. `await headers()` — this caches the current sealed read-only Headers
 *      snapshot on the shared HeadersContext.
 *   2. Returns `NextResponse.next({ request: { headers: modified } })` where
 *      `modified` drops `authorization`/`cookie` and adds `x-from-middleware`.
 *
 * A correct implementation must invalidate the cached sealed Headers when the
 * underlying `HeadersContext.headers` is replaced by
 * `applyMiddlewareRequestHeaders()`, so the Server Component sees the
 * middleware-modified view. Before the fix, `_getReadonlyHeaders()` returned
 * the stale snapshot and the Server Component still saw the original request
 * headers (`authorization` present, `x-from-middleware` missing).
 */
export default async function HeaderOverrideAfterPriorAccessPage() {
  const requestHeaders = await headers();
  const requestCookies = await cookies();

  return (
    <div>
      <p id="authorization">{requestHeaders.get("authorization") ?? "null"}</p>
      <p id="cookie">{requestHeaders.get("cookie") ?? "null"}</p>
      <p id="middleware-header">{requestHeaders.get("x-from-middleware") ?? "null"}</p>
      <p id="cookie-count">{String(requestCookies.getAll().length)}</p>
    </div>
  );
}
