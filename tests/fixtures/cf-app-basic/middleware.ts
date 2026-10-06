import { draftMode } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Mirrors the upstream `app-middleware` fixture: mutate the *request* headers
 * so downstream handlers (including Pages Router `pages/api/*`) observe the
 * injected header, and enable draft mode on `?draft=true`. Regression coverage
 * for #1520.
 */
export async function middleware(request: NextRequest) {
  if (/^\/api\/browser-cache(?:-pages)?-bot-blocked$/.test(request.nextUrl.pathname)) {
    return request.headers.get("user-agent")?.toLowerCase().includes("gptbot")
      ? new NextResponse(null, { status: 403 })
      : NextResponse.next();
  }
  if (/^\/api\/browser-cache(?:-pages)?-proxy$/.test(request.nextUrl.pathname)) {
    const response = NextResponse.next();
    response.headers.set("Cache-Control", "public, max-age=300");
    return response;
  }
  const visitorId = request.headers.get("x-test-visitor-id") ?? "anonymous";
  if (
    request.headers.has("x-test-visitor-id") &&
    (request.nextUrl.pathname === "/api/browser-cache-query" ||
      request.nextUrl.pathname === "/api/browser-cache-pages-query")
  ) {
    const destination = request.nextUrl.clone();
    destination.searchParams.set("visitor", visitorId);
    return NextResponse.rewrite(destination);
  }
  if (
    request.nextUrl.pathname.startsWith("/api/browser-cache") &&
    request.headers.has("x-test-visitor-id")
  ) {
    const response = NextResponse.next();
    response.headers.set("x-cdn-stage-visitor", visitorId);
    return response;
  }
  if (request.nextUrl.pathname.startsWith("/cdn-stage-cookie/")) {
    const response = NextResponse.next();
    response.cookies.set("stage-cookie", visitorId);
    response.headers.set("x-cdn-stage-visitor", visitorId);
    return response;
  }
  if (request.nextUrl.pathname === "/%61dmin") {
    return NextResponse.rewrite(new URL("/admin", request.url));
  }
  if (request.nextUrl.pathname.startsWith("/encoded-parity/rewrite/")) {
    const target = request.nextUrl.clone();
    target.pathname = request.nextUrl.pathname.replace(
      "/encoded-parity/rewrite/",
      "/encoded-parity/page/",
    );
    return NextResponse.rewrite(target);
  }
  if (request.nextUrl.searchParams.get("draft")) {
    (await draftMode()).enable();
  }
  const headers = new Headers(request.headers);
  const testsMiddlewareRequestHeaders =
    request.nextUrl.pathname.startsWith("/api/dump-headers") ||
    request.nextUrl.pathname.startsWith("/api/cdn-stage-middleware-header/");
  if (request.nextUrl.pathname.startsWith("/api/cdn-stage-middleware-header/")) {
    headers.set("x-from-middleware", visitorId);
  } else {
    headers.set("x-from-middleware", "hello-from-middleware");
  }
  const response = testsMiddlewareRequestHeaders
    ? NextResponse.next({ request: { headers } })
    : NextResponse.next();
  if (
    request.nextUrl.pathname.startsWith("/cdn-stage-app/") ||
    request.nextUrl.pathname.startsWith("/cdn-stage-cookie/") ||
    request.nextUrl.pathname.startsWith("/cdn-stage-late/") ||
    request.nextUrl.pathname.startsWith("/api/cdn-stage-late-route/") ||
    request.nextUrl.pathname.startsWith("/api/cdn-stage-middleware-header/") ||
    request.nextUrl.pathname.startsWith("/cdn-stage-pages/")
  ) {
    response.headers.set("x-cdn-stage-visitor", visitorId);
  }
  if (
    request.nextUrl.pathname.startsWith("/api/draft-isr/") &&
    request.headers.has("x-browser-policy")
  ) {
    response.headers.set("Cache-Control", "public, max-age=300");
  }
  return response;
}

// Browser-TTL fixtures bypass middleware; the conditional fixtures exercise
// pathname eligibility even when the request-specific matcher does not run.
export const config = {
  matcher: [
    "/((?!api/browser-cache(?:-pages)?(?:-(?:shared|static|config|conditional|middleware|redirect|rewrite|swr|generated-edge))?$).*)",
    {
      source: "/api/browser-cache-middleware",
      has: [{ type: "header", key: "x-test-visitor-id" }],
    },
    {
      source: "/api/browser-cache-pages-middleware",
      has: [{ type: "header", key: "x-test-visitor-id" }],
    },
  ],
};
