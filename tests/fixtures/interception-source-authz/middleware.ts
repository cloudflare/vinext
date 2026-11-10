import { NextResponse, type NextRequest } from "next/server";

function blocked() {
  return new Response("Blocked by middleware", {
    status: 403,
    headers: { "x-auth-guard": "blocked" },
  });
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname.startsWith("/photos/")) {
    // Photos vouch for every viewer of their own route.
    const headers = new Headers(request.headers);
    headers.set("x-trusted-viewer", "1");
    return NextResponse.next({ request: { headers } });
  }
  if (pathname.startsWith("/viewers/")) {
    return request.headers.get("x-trusted-viewer") === "1" ? NextResponse.next() : blocked();
  }
  return blocked();
}

export const config = {
  matcher: ["/feed/:path*", "/vault", "/photos/:path*", "/viewers/:path*"],
};
