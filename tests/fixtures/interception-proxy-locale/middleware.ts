import { NextResponse, type NextRequest } from "next/server";

// Mirrors Next.js: test/e2e/app-dir/interception-dynamic-segment-middleware/middleware.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/interception-dynamic-segment-middleware/middleware.ts
// The default locale is unprefixed: /feed is served by /en/feed.
export default function middleware(request: NextRequest) {
  const locale = "en";
  const { pathname } = request.nextUrl;
  if (pathname.startsWith(`/${locale}/`) || pathname === `/${locale}`) return;

  request.nextUrl.pathname = `/${locale}${pathname}`;
  return NextResponse.rewrite(request.nextUrl);
}

export const config = {
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"],
};
