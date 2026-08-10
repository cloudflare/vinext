import { NextResponse, type NextRequest } from "next/server";
export function middleware(request: NextRequest) {
  if (
    request.nextUrl.pathname === "/ownership/admin" ||
    request.nextUrl.pathname === "/ownership/report/client-owner" ||
    request.nextUrl.pathname.startsWith("/ownership/report/admin")
  )
    return new NextResponse("ADMIN_BLOCKED", { status: 401 });
  if (request.nextUrl.pathname === "/ownership/report/dynamic/[id]")
    return new NextResponse("DYNAMIC_BLOCKED", { status: 401 });
  if (request.nextUrl.pathname === "/ownership/report/cookie-source") {
    const headers = new Headers(request.headers);
    headers.set("x-forwarded-auth", "trusted");
    const response = NextResponse.next({ request: { headers } });
    response.cookies.set("forwarded-cookie", "present");
    return response;
  }
  if (request.nextUrl.pathname === "/ownership/report/loop") {
    return NextResponse.rewrite(new URL("/ownership/report/public", request.url));
  }
  if (
    request.nextUrl.pathname === "/ownership/same-name/action-owner" &&
    request.headers.get("x-action-forwarded")
  ) {
    return new NextResponse("FORWARDED_SAME_NAME_ACTION_BLOCKED", { status: 401 });
  }
  if (
    request.nextUrl.pathname === "/ownership/report/cache-owner" &&
    request.headers.get("x-action-forwarded")
  ) {
    return new NextResponse("FORWARDED_CACHE_ACTION_BLOCKED", { status: 401 });
  }
  return NextResponse.next();
}
export const config = {
  matcher: [
    "/ownership/admin",
    "/ownership/report/admin/:path*",
    "/ownership/report/client-owner",
    "/ownership/report/dynamic/:path*",
    "/ownership/report/cookie-source",
    "/ownership/report/loop",
    "/ownership/report/cache-owner",
    "/ownership/same-name/action-owner",
  ],
};
