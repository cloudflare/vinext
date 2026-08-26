import { NextResponse } from "next/server";

export function proxy() {
  const response = NextResponse.next();
  response.headers.set("X-Cacheability-Middleware", "matched");
  return response;
}

export const config = {
  matcher: [
    "/cacheability/middleware",
    {
      source: "/cacheability/conditional-middleware-cookie",
      has: [{ type: "cookie", key: "cacheability-middleware" }],
    },
    {
      source: "/cacheability/conditional-middleware-header",
      has: [{ type: "header", key: "x-cacheability-middleware", value: "enabled" }],
    },
    {
      source: "/cacheability-pages/middleware",
      has: [{ type: "cookie", key: "variant", value: "private" }],
    },
  ],
};
