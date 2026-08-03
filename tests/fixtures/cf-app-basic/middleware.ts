import { draftMode } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Mirrors the upstream `app-middleware` fixture: mutate the *request* headers
 * so downstream handlers (including Pages Router `pages/api/*`) observe the
 * injected header, and enable draft mode on `?draft=true`. Regression coverage
 * for #1520.
 */
export async function middleware(request: NextRequest) {
  if (request.nextUrl.pathname === "/middleware-isr-redirect") {
    const response = NextResponse.redirect(new URL("/about", request.url));
    response.headers.set(
      "x-visitor-id",
      request.headers.get("x-test-visitor-id") ?? crypto.randomUUID(),
    );
    response.headers.set("Cache-Control", "public, s-maxage=60");
    response.headers.set("CDN-Cache-Control", "public, max-age=60");
    response.headers.set("Cloudflare-CDN-Cache-Control", "public, max-age=60");
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
  headers.set("x-from-middleware", "hello-from-middleware");
  const response = NextResponse.next({ request: { headers } });
  if (
    request.nextUrl.pathname.startsWith("/middleware-isr/") ||
    request.nextUrl.pathname.startsWith("/pages-middleware-isr/") ||
    request.nextUrl.pathname.startsWith("/api/middleware-isr/")
  ) {
    response.headers.set(
      "x-visitor-id",
      request.headers.get("x-test-visitor-id") ?? crypto.randomUUID(),
    );
    // A middleware cache override must not be able to re-enable shared caching
    // above the Worker and replay the per-request header.
    response.headers.set("Cache-Control", "public, s-maxage=60");
    response.headers.set("CDN-Cache-Control", "public, max-age=60");
    response.headers.set("Cloudflare-CDN-Cache-Control", "public, max-age=60");
    if (request.headers.get("x-test-private-link") === "1") {
      response.headers.set("Link", "</visitor-a.css>; rel=preload; as=style");
    }
  }
  if (request.nextUrl.pathname.startsWith("/middleware-isr-cookie/")) {
    response.cookies.set("visitor-id", crypto.randomUUID());
  }
  return response;
}

export const config = {
  matcher: [
    "/((?!conditional-config-redirect|conditional-config-rewrite|config-header-app|matcher-excluded-app|matcher-excluded-pages).*)",
  ],
};
