import { NextRequest, NextResponse } from "next/server";

/**
 * Middleware for pages-router-cloudflare example.
 *
 * Sets an x-mw-ran header on matched requests so the e2e tests can assert
 * that middleware actually ran (and didn't crash with the outsideEmitter bug).
 */
export function middleware(request: NextRequest) {
  const response = NextResponse.next();
  response.headers.set("x-mw-ran", "true");
  return response;
}

export const config = {
  matcher: ["/api/:path*", "/ssr"],
};
