import { NextRequest, NextResponse } from "next/server";

/**
 * Middleware for app-router-cloudflare example.
 */
export function middleware(request: NextRequest) {
  // A `members=1` cookie admits `?members-only`; the image optimizer fetches
  // its source without the caller's cookies, as Next.js does.
  // Coverage: tests/e2e/cloudflare-workers/image-middleware.spec.ts
  if (request.nextUrl.pathname === "/vinext-image.png") {
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
  if (request.nextUrl.pathname === "/image-source-rewrite.png") {
    return NextResponse.rewrite(new URL("/vinext-image.png", request.url));
  }
  if (request.nextUrl.pathname === "/admin") {
    return new Response("Blocked by middleware", { status: 403 });
  }
  // A `members=1` cookie admits direct requests; the image optimizer fetches
  // its source without the caller's cookies, as Next.js does.
  if (
    request.nextUrl.pathname.startsWith("/protected/") &&
    request.cookies.get("members")?.value !== "1"
  ) {
    return new Response("blocked by middleware", {
      status: 403,
      headers: { "content-type": "text/plain" },
    });
  }
  // The image endpoint passes through middleware before it reads a source.
  if (request.nextUrl.pathname === "/_next/image" || request.nextUrl.pathname === "/_vinext/image") {
    if (request.nextUrl.searchParams.has("deny")) {
      return new Response("image endpoint blocked by middleware", {
        status: 403,
        headers: { "content-type": "text/plain" },
      });
    }
    if (request.nextUrl.searchParams.get("url") === "/image-endpoint-replaced.png") {
      const target = request.nextUrl.clone();
      target.searchParams.set("url", "/vinext-image.png");
      return NextResponse.rewrite(target);
    }
    const response = NextResponse.next();
    response.headers.set("x-mw-image-endpoint", "true");
    return response;
  }
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
  if (request.nextUrl.pathname.startsWith("/api/framed-get")) {
    response.headers.set("x-mw-body-null", String(request.body === null));
  }
  return response;
}

export const config = {
  matcher: [
    "/api/:path*",
    "/",
    "/admin",
    "/_next/static/middleware-rewrite.js",
    "/vinext-image.png",
    "/image-source-rewrite.png",
    "/protected/:path*",
    "/_next/image",
    "/_vinext/image",
  ],
};
