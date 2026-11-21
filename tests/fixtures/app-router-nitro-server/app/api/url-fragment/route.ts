import type { NextRequest } from "next/server";

// Next.js never shows handlers a `#fragment` sent on the request line, so this
// cached handler must not store one.
// Coverage: tests/e2e/app-router-nitro-server/server.spec.ts
export const revalidate = 60;

export function GET(request: NextRequest) {
  return Response.json({ pathname: request.nextUrl.pathname, hash: request.nextUrl.hash });
}
