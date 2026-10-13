import { NextResponse, type NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Mirrors the redirect cases in Next.js's skip-trailing-slash-redirect
  // fixture middleware, with same-origin targets.
  if (pathname === "/middleware-redirect-with") {
    return NextResponse.redirect(new URL("/another/", request.url));
  }
  if (pathname === "/middleware-redirect-without") {
    return NextResponse.redirect(new URL("/another", request.url));
  }

  const response = NextResponse.next();
  response.headers.set("x-next-url-pathname", new URL(request.nextUrl.href).pathname);
  return response;
}

export const config = {
  matcher: ["/((?!_next/).*)"],
};
