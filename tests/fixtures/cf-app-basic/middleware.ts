import { draftMode } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Mirrors the upstream `app-middleware` fixture: mutate the *request* headers
 * so downstream handlers (including Pages Router `pages/api/*`) observe the
 * injected header, and enable draft mode on `?draft=true`. Regression coverage
 * for #1520.
 */
export async function middleware(request: NextRequest) {
  const visitorId = request.headers.get("x-test-visitor-id") ?? "anonymous";
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
  headers.set("x-from-middleware", "hello-from-middleware");
  const response = NextResponse.next({ request: { headers } });
  if (
    request.nextUrl.pathname.startsWith("/cdn-stage-app/") ||
    request.nextUrl.pathname.startsWith("/cdn-stage-cookie/") ||
    request.nextUrl.pathname.startsWith("/cdn-stage-late/") ||
    request.nextUrl.pathname.startsWith("/api/cdn-stage-late-route/") ||
    request.nextUrl.pathname.startsWith("/cdn-stage-pages/")
  ) {
    response.headers.set("x-cdn-stage-visitor", visitorId);
  }
  return response;
}
