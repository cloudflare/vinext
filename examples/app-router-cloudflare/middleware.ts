import { NextRequest, NextResponse } from "next/server";

/**
 * Middleware for app-router-cloudflare example.
 */
export function middleware(request: NextRequest) {
  const response = NextResponse.next();
  response.headers.set("x-mw-ran", "true");
  return response;
}

export const config = {
  matcher: ["/api/:path*", "/"],
};
