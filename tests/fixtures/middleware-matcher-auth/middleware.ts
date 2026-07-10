import type { NextRequest } from "next/server";

export function middleware(_request: NextRequest) {
  return new Response("blocked by middleware", {
    status: 403,
    headers: { "x-auth-guard": "blocked" },
  });
}

export const config = {
  matcher: [
    "/(admin|dashboard)/:path*",
    "/",
    "/(de|en)/:path*",
    "/docs/:lang(en|fr)*",
    "/manual/:lang(en|fr)+",
    "/(foo.*|bar)/:path*",
  ],
};
