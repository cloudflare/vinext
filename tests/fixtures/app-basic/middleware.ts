import { NextRequest, NextResponse } from "next/server";

/**
 * App Router middleware that uses NextRequest-specific APIs.
 * This tests that the middleware receives a NextRequest (not a plain Request).
 *
 * Also covers OpenNext compat tests (ON-11):
 * - Redirect with cookie setting
 * - Rewrite (URL stays, content from another page)
 * - Rewrite with custom status code
 * - Block with 403
 * - Search params forwarding
 */
export function middleware(request: NextRequest) {
  // Test NextRequest.nextUrl - this would fail with TypeError if request is plain Request
  const { pathname } = request.nextUrl;

  // Test NextRequest.cookies - this would fail with TypeError if request is plain Request
  const sessionToken = request.cookies.get("session");

  const response = NextResponse.next();

  // Add headers to prove middleware ran and NextRequest APIs worked
  response.headers.set("x-mw-pathname", pathname);
  response.headers.set("x-mw-ran", "true");

  if (sessionToken) {
    response.headers.set("x-mw-has-session", "true");
  }

  // Redirect /middleware-redirect to /about (with cookie, like OpenNext)
  // Ref: opennextjs-cloudflare middleware.ts — redirect with set-cookie header
  if (pathname === "/middleware-redirect") {
    return NextResponse.redirect(new URL("/about", request.url), {
      headers: { "set-cookie": "middleware-redirect=success; Path=/" },
    });
  }

  // Rewrite /middleware-rewrite to render / content (URL stays the same)
  // Ref: opennextjs-cloudflare middleware.ts — NextResponse.rewrite
  if (pathname === "/middleware-rewrite") {
    return NextResponse.rewrite(new URL("/", request.url));
  }

  // Rewrite with custom status code
  // Ref: opennextjs-cloudflare middleware.ts — NextResponse.rewrite with status
  if (pathname === "/middleware-rewrite-status") {
    return NextResponse.rewrite(new URL("/", request.url), {
      status: 403,
    });
  }

  // Block /middleware-blocked with custom response
  if (pathname === "/middleware-blocked") {
    return new Response("Blocked by middleware", { status: 403 });
  }

  // Throw an error to test that middleware errors return 500, not bypass auth
  if (pathname === "/middleware-throw") {
    throw new Error("middleware crash");
  }

  // Inject mw-before-user=1 cookie for beforeFiles rewrite gating test.
  // In App Router order, beforeFiles rewrites run after middleware, so they
  // should see this cookie. The /mw-gated-before rule in next.config.ts has:
  // [cookie:mw-before-user], which matches when ?mw-auth is present.
  if (pathname === "/mw-gated-before" && request.nextUrl.searchParams.has("mw-auth")) {
    const headers = new Headers(request.headers);
    const existing = headers.get("cookie") ?? "";
    headers.set("cookie", existing ? existing + "; mw-before-user=1" : "mw-before-user=1");
    return NextResponse.next({ request: { headers } });
  }

  // Inject mw-fallback-user=1 cookie for fallback rewrite gating test.
  // Fallback rewrites run after middleware and after a 404 from route matching.
  // The /mw-gated-fallback rule has: [cookie:mw-fallback-user].
  if (pathname === "/mw-gated-fallback" && request.nextUrl.searchParams.has("mw-auth")) {
    const headers = new Headers(request.headers);
    const existing = headers.get("cookie") ?? "";
    headers.set("cookie", existing ? existing + "; mw-fallback-user=1" : "mw-fallback-user=1");
    return NextResponse.next({ request: { headers } });
  }

  // Forward search params as a header for RSC testing
  // Ref: opennextjs-cloudflare middleware.ts — search-params header
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(
    "x-search-params",
    `mw/${request.nextUrl.searchParams.get("searchParams") || ""}`,
  );
  const r = NextResponse.next({
    request: { headers: requestHeaders },
  });
  r.headers.set("x-mw-pathname", pathname);
  r.headers.set("x-mw-ran", "true");
  if (sessionToken) {
    r.headers.set("x-mw-has-session", "true");
  }
  return r;
}

export const config = {
  matcher: [
    "/about",
    "/middleware-redirect",
    "/middleware-rewrite",
    "/middleware-rewrite-status",
    "/middleware-blocked",
    "/middleware-throw",
    "/search-query",
    "/",
    "/mw-gated-before",
    "/mw-gated-fallback",
  ],
};
