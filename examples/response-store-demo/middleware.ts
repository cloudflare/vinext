import { NextResponse, type NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if ((pathname === "/dashboard" || pathname === "/api/dashboard") && !request.cookies.has("session")) {
    return NextResponse.redirect(new URL("/?gate=middleware", request.url));
  }
  if (pathname === "/api/browser-cache-policy/bot-blocked") {
    return request.headers.get("user-agent")?.toLowerCase().includes("gptbot")
      ? new NextResponse(null, { status: 403 })
      : NextResponse.next();
  }
  const response = request.headers.has("x-test-middleware-status")
    ? NextResponse.next({ status: 202 })
    : NextResponse.next();
  if (pathname === "/api/browser-cache-policy/proxy") {
    response.headers.set("Cache-Control", "public, max-age=10");
    return response;
  }
  response.headers.set(
    "x-workers-cache-visitor",
    request.headers.get("x-test-visitor-id") ?? "anonymous",
  );
  return response;
}

export const config = { matcher: ["/dashboard", "/api/dashboard", "/prewarm-target", "/pages-prewarm", "/api/browser-cache-policy/middleware", "/api/browser-cache-policy/bot-blocked", "/api/browser-cache-policy/proxy"] };
