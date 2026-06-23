import { NextRequest, NextResponse } from "next/server";

/**
 * Middleware for app-router-cloudflare example.
 */
export function middleware(request: NextRequest) {
  if (request.nextUrl.pathname === "/_next/static/middleware-rewrite.js") {
    return new Response("rewritten missing asset", {
      headers: { "content-type": "text/plain" },
    });
  }

  const response = NextResponse.next();
  response.headers.set("x-mw-ran", "true");
  return response;
}

export const config = {
  matcher: ["/api/:path*", "/", "/_next/static/middleware-rewrite.js"],
};
