import { NextRequest, NextResponse } from "next/server";

// A `members=1` cookie admits direct requests; the image optimizer fetches
// its source without the caller's cookies, as Next.js does.
export function middleware(request: NextRequest) {
  if (request.cookies.get("members")?.value !== "1") {
    return new Response("blocked by middleware", {
      status: 403,
      headers: { "content-type": "text/plain" },
    });
  }
  return NextResponse.next();
}

export const config = { matcher: ["/protected/:path*"] };
