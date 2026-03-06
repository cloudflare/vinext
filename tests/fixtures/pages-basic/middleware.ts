import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const url = new URL(request.url);

  // Add a custom header to all matched requests
  const response = NextResponse.next();
  response.headers.set("x-custom-middleware", "active");

  // Redirect /old-page to /about
  if (url.pathname === "/old-page") {
    return NextResponse.redirect(new URL("/about", request.url));
  }

  // Rewrite /rewritten to /ssr
  if (url.pathname === "/rewritten") {
    return NextResponse.rewrite(new URL("/ssr", request.url));
  }

  // Block /blocked with a custom response
  if (url.pathname === "/blocked") {
    return new Response("Access Denied", { status: 403 });
  }

  // Throw an error to test that middleware errors return 500, not bypass auth
  if (url.pathname === "/middleware-throw") {
    throw new Error("middleware crash");
  }

  // Forward modified request headers via NextResponse.next({ request: { headers } })
  // to test that x-middleware-request-* headers survive runMiddleware stripping.
  if (url.pathname === "/header-override") {
    const headers = new Headers(request.headers);
    headers.set("x-custom-injected", "from-middleware");
    return NextResponse.next({ request: { headers } });
  }

  // Inject a cookie via middleware request headers. Config has/missing
  // conditions should see this cookie even though the original request
  // did not include it.
  if (url.pathname === "/about" && url.searchParams.has("inject-login")) {
    const headers = new Headers(request.headers);
    const existing = headers.get("cookie") ?? "";
    headers.set("cookie", existing ? existing + "; logged-in=1" : "logged-in=1");
    return NextResponse.next({ request: { headers } });
  }

  return response;
}

export const config = {
  matcher: ["/((?!api|_next|favicon\\.ico).*)"],
};
