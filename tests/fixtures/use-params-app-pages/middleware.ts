import { NextResponse, type NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Mirrors the redirect cases in Next.js's skip-trailing-slash-redirect
  // fixture middleware, with same-origin targets.
  if (pathname === "/skip-trailing-slash/middleware-redirect-with") {
    return NextResponse.redirect(new URL("/skip-trailing-slash/another/", request.url));
  }
  if (pathname === "/skip-trailing-slash/middleware-redirect-without") {
    return NextResponse.redirect(new URL("/skip-trailing-slash/another", request.url));
  }

  const response = NextResponse.next();
  response.headers.set("x-next-url-pathname", new URL(request.nextUrl.href).pathname);
  return response;
}

// Only the skipTrailingSlashRedirect routes; the use-params routes run without
// middleware.
export const config = {
  matcher: ["/skip-trailing-slash/:path*", "/with-app-dir/:path*", "/api/edge-url"],
};
