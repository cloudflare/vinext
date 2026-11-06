import type { NextRequest } from "next/server";

export function GET(request: NextRequest) {
  return Response.json({
    url: new URL(request.url).pathname,
    nextUrl: request.nextUrl.pathname,
  });
}
