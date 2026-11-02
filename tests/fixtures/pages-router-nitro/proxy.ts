import { NextResponse, type NextRequest } from "next/server";

export function proxy(request: NextRequest) {
  if (request.nextUrl.pathname === "/blocked.txt") {
    return NextResponse.json({ proxy: true }, { status: 403 });
  }
  // Coverage: tests/e2e/pages-router-nitro/server.spec.ts
  if (request.nextUrl.pathname === "/proxy-request-url") {
    return NextResponse.json({ url: request.url, hash: request.nextUrl.hash });
  }
  if (request.nextUrl.pathname === "/rewrite-to-hello") {
    return NextResponse.rewrite(new URL("/hello.txt", request.url));
  }
  // Proxies /legacy/* to another site, whose origin the test names.
  const legacyOrigin = request.headers.get("x-legacy-origin");
  if (legacyOrigin && request.nextUrl.pathname.startsWith("/legacy/")) {
    return NextResponse.rewrite(
      new URL(request.nextUrl.pathname.slice("/legacy".length), legacyOrigin),
    );
  }
  const response = NextResponse.next();
  response.headers.set("x-vinext-proxy", "active");
  return response;
}

export const config = {
  matcher: ["/((?!_next/static).*)"],
};
