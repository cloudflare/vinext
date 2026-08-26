import { NextResponse } from "next/server";

export function proxy() {
  const response = NextResponse.next();
  response.headers.set("X-Cacheability-Middleware", "matched");
  return response;
}

export const config = { matcher: "/cacheability/middleware" };
