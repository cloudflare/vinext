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
  if (request.nextUrl.searchParams.has("csp-nonce")) {
    response.headers.set(
      "content-security-policy",
      "script-src 'nonce-vinext-test-nonce' 'strict-dynamic';",
    );
  }
  response.headers.set("x-mw-ran", "true");
  return response;
}

export const config = {
  matcher: ["/api/:path*", "/", "/_next/static/middleware-rewrite.js"],
};
