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
  // A `members=1` cookie admits `?members-only`; the image optimizer fetches
  // its source without the caller's cookies, as Next.js does.
  // Coverage: tests/e2e/cloudflare-pages-router/image-middleware.spec.ts
  if (pathname === "/vinext-image.png") {
    if (
      request.nextUrl.searchParams.has("members-only") &&
      request.cookies.get("members")?.value !== "1"
    ) {
      return new Response("blocked by middleware", { status: 403 });
    }
    if (request.nextUrl.searchParams.has("redirect")) {
      return NextResponse.redirect(new URL("/vinext-image.png", request.url));
    }
  }
  if (pathname === "/image-source-rewrite.png") {
    return NextResponse.rewrite(new URL("/vinext-image.png", request.url));
  }
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
    "/vinext-image.png",
    "/image-source-rewrite.png",
  ],
};
