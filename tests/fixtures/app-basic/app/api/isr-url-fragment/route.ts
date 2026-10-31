import type { NextRequest } from "next/server";

// Next.js never shows handlers a `#fragment` sent on the request line, so this
// cached handler must not store one.
// Coverage: tests/app-router-production-server.test.ts
export const revalidate = 60;

export function GET(request: NextRequest) {
  return Response.json({ pathname: request.nextUrl.pathname, hash: request.nextUrl.hash });
}
