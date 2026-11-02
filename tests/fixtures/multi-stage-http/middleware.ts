import { NextResponse, type NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const aliasMatch = request.nextUrl.pathname.match(/^\/alias-(.+)$/);
  const response = aliasMatch
    ? NextResponse.rewrite(new URL(`/${aliasMatch[1]}`, request.url))
    : NextResponse.next();
  if (request.nextUrl.pathname === "/stage-asset.txt") {
    response.headers.set("content-encoding", "gzip");
    response.headers.set("content-length", "999");
    response.headers.set("content-type", "application/wrong");
    response.headers.set("transfer-encoding", "chunked");
  }
  response.headers.set(
    "x-http-stage-visitor",
    request.headers.get("x-test-visitor") ?? "anonymous",
  );
  if (request.nextUrl.pathname === "/api/auth-challenge") {
    response.headers.set("WWW-Authenticate", 'Basic realm="middleware"');
    response.headers.set("Proxy-Authenticate", 'Basic realm="middleware"');
    response.headers.set("x-auth-source", "middleware");
  }
  // Sliding-session refresh: re-issue the session cookie with a renewed
  // expiry. The route handler's logout/rotation cookie must still win.
  const session = request.cookies.get("session");
  if (
    (request.nextUrl.pathname === "/api/session-refresh" ||
      request.nextUrl.pathname === "/api/session-logout") &&
    session
  ) {
    response.cookies.set("session", session.value, { path: "/", httpOnly: true, maxAge: 600 });
  }
  return response;
}
