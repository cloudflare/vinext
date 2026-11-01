import { NextResponse, type NextRequest } from "next/server";

// From https://github.com/cloudflare/vinext/issues/4397: the default locale
// (ja) is served without a URL prefix. Unprefixed URLs rewrite to /ja, and
// prefixed /ja URLs redirect to their canonical unprefixed spelling.
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname === "/ja" || pathname.startsWith("/ja/")) {
    const url = request.nextUrl.clone();
    url.pathname = pathname.slice(3) || "/";
    return NextResponse.redirect(url);
  }
  if (!pathname.startsWith("/en/") && pathname !== "/en") {
    const url = request.nextUrl.clone();
    url.pathname = `/ja${pathname}`;
    return NextResponse.rewrite(url);
  }
  return NextResponse.next();
}

export const config = { matcher: ["/tips", "/tips/:path*", "/ja/:path*", "/en/:path*"] };
