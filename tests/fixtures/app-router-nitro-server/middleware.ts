// Uses the `middleware.ts` convention; the Pages Router fixture uses `proxy.ts`.
import { NextResponse, type NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  if (request.nextUrl.pathname === "/blocked.txt") {
    return NextResponse.json({ middleware: true }, { status: 403 });
  }
  const response = NextResponse.next();
  response.headers.set("x-vinext-middleware", "active");
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|unmatched\\.txt).*)"],
};
