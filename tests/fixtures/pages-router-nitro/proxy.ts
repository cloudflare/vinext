import { NextResponse } from "next/server";

export function proxy() {
  const response = NextResponse.next();
  response.headers.set("x-vinext-proxy", "active");
  return response;
}

export const config = {
  matcher: ["/((?!_next/static).*)"],
};
