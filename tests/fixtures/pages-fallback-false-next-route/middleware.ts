import { NextResponse } from "next/server";

export function middleware() {
  const response = NextResponse.next();
  response.headers.set("x-fixture-middleware", "1");
  response.headers.append("set-cookie", "mw=1; Path=/");
  return response;
}

export const config = { matcher: "/chain/:path*" };
