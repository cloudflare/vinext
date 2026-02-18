import { NextRequest, NextResponse } from "next/server";

/**
 * App Router middleware that uses NextRequest-specific APIs.
 * This tests that the middleware receives a NextRequest (not a plain Request).
 */
export function middleware(request: NextRequest) {
  // Test NextRequest.nextUrl - this would fail with TypeError if request is plain Request
  const { pathname } = request.nextUrl;
  
  // Test NextRequest.cookies - this would fail with TypeError if request is plain Request
  const sessionToken = request.cookies.get("session");
  
  const response = NextResponse.next();
  
  // Add headers to prove middleware ran and NextRequest APIs worked
  response.headers.set("x-middleware-pathname", pathname);
  response.headers.set("x-middleware-ran", "true");
  
  if (sessionToken) {
    response.headers.set("x-middleware-has-session", "true");
  }
  
  // Redirect /middleware-redirect to /about
  if (pathname === "/middleware-redirect") {
    return NextResponse.redirect(new URL("/about", request.url));
  }
  
  // Rewrite /middleware-rewrite to render / content
  if (pathname === "/middleware-rewrite") {
    return NextResponse.rewrite(new URL("/", request.url));
  }
  
  // Block /middleware-blocked with custom response
  if (pathname === "/middleware-blocked") {
    return new Response("Blocked by middleware", { status: 403 });
  }
  
  return response;
}

export const config = {
  // Use a simpler matcher pattern for testing
  matcher: ["/about", "/middleware-redirect", "/middleware-rewrite", "/middleware-blocked", "/"],
};
