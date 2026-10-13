import type { NextRequest } from "next/server";

export const config = { runtime: "edge" };

export default function handler(request: NextRequest) {
  return Response.json({
    url: new URL(request.url).pathname,
    nextUrl: request.nextUrl.pathname,
  });
}
