import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const response = NextResponse.next();

  // Add custom header to all responses
  response.headers.set("x-vinext-middleware", "active");

  // Track visit count in cookie
  const visits = Number.parseInt(
    request.cookies.get("visit-count")?.value ?? "0",
    10,
  );
  response.cookies.set("visit-count", String(visits + 1), { path: "/" });

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
