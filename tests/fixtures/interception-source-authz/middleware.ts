import type { NextRequest } from "next/server";

export function middleware(_request: NextRequest) {
  return new Response("Blocked by middleware", {
    status: 403,
    headers: { "x-auth-guard": "blocked" },
  });
}

export const config = {
  matcher: ["/feed/:path*"],
};
