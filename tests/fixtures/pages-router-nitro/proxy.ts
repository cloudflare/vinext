import { NextResponse, type NextRequest } from "next/server";

export function proxy(request: NextRequest) {
  if (request.nextUrl.pathname === "/blocked.txt") {
    return NextResponse.json({ proxy: true }, { status: 403 });
  }
  const response = NextResponse.next();
  response.headers.set("x-vinext-proxy", "active");
  return response;
}

export const config = {
  matcher: ["/((?!_next/static).*)"],
};
