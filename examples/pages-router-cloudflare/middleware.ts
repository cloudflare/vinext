import { NextRequest, NextResponse } from "next/server";

// With skipProxyUrlNormalize, the page's data request reaches middleware with
// its raw `/_next/data/<buildId>/members.json` URL.
const MEMBERS_DATA_PATH = /^\/_next\/data\/[^/]+\/members\.json$/;

/**
 * Middleware for pages-router-cloudflare example.
 *
 * Sets an x-mw-ran header on matched requests so the e2e tests can assert
 * that middleware actually ran (and didn't crash with the outsideEmitter bug).
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname === "/members" || MEMBERS_DATA_PATH.test(pathname)) {
    if (request.cookies.get("members-session")?.value !== "valid") {
      return new Response("members only", {
        status: 403,
        headers: { "x-mw-pathname": pathname },
      });
    }
  }

  if (request.nextUrl.pathname === "/_next/static/middleware-rewrite.js") {
    return new Response("rewritten missing asset", {
      headers: { "content-type": "text/plain" },
    });
  }

  if (request.nextUrl.pathname === "/headers-before-middleware-rewrite") {
    return NextResponse.rewrite(new URL("/ssr", request.url));
  }

  if (request.nextUrl.pathname === "/redirect-before-middleware-rewrite") {
    return NextResponse.redirect(new URL("/ssr", request.url));
  }

  if (request.nextUrl.pathname === "/redirect-before-middleware-response") {
    return new Response("middleware response", { status: 418 });
  }

  const response = NextResponse.next();
  response.headers.set("x-mw-ran", "true");
  response.headers.set("x-mw-pathname", request.nextUrl.pathname);
  return response;
}

export const config = {
  matcher: [
    "/api/:path*",
    "/about",
    "/members",
    "/ssr",
    "/headers-before-middleware-rewrite",
    "/redirect-before-middleware-rewrite",
    "/redirect-before-middleware-response",
    "/_next/static/middleware-rewrite.js",
  ],
};
