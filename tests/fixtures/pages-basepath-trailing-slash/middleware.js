import { NextResponse } from "next/server";

// The matcher is written without the basePath; Next.js prefixes it, so it
// gates only /docs/private/* and /docs/mw-rewrite/*.
export function middleware(request) {
  const { pathname } = request.nextUrl;
  // A rewrite destination resolves only under the basePath, so these
  // unprefixed targets 404 as they do in Next.js.
  if (pathname === "/mw-rewrite/outside-file/") {
    return NextResponse.rewrite(new URL("/open.txt", request.url));
  }
  if (pathname === "/mw-rewrite/outside-page/") {
    return NextResponse.rewrite(new URL("/hello/", request.url));
  }
  if (pathname === "/mw-rewrite/inside-file/") {
    return NextResponse.rewrite(new URL("/docs/open.txt", request.url));
  }
  if (pathname === "/mw-rewrite/inside-page/") {
    return NextResponse.rewrite(new URL("/docs/hello/", request.url));
  }
  return new Response("blocked by middleware", { status: 403 });
}

export const config = {
  matcher: ["/private/:path*", "/mw-rewrite/:path*"],
};
