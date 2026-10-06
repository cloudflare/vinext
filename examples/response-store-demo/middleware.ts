import { NextResponse, type NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if (pathname === "/api/browser-cache-policy/bot-blocked") {
    return request.headers.get("user-agent")?.toLowerCase().includes("gptbot")
      ? new NextResponse(null, { status: 403 })
      : NextResponse.next();
  }
  const response = NextResponse.next();
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

export const config = { matcher: ["/prewarm-target", "/pages-prewarm", "/api/browser-cache-policy/middleware", "/api/browser-cache-policy/bot-blocked", "/api/browser-cache-policy/proxy"] };
