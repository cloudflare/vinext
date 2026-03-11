import { NextRequest, NextResponse } from "next/server";

/**
 * Middleware for pages-router-cloudflare example.
 *
 * Sets an x-mw-ran header on matched requests so the e2e tests can assert
 * that middleware actually ran (and didn't crash with the outsideEmitter bug).
 */
export function middleware(request: NextRequest) {
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
  return response;
}

export const config = {
  matcher: [
    "/api/:path*",
    "/ssr",
    "/headers-before-middleware-rewrite",
    "/redirect-before-middleware-rewrite",
    "/redirect-before-middleware-response",
  ],
};
