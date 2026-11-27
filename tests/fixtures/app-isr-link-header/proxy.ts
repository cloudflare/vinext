import { NextResponse } from "next/server";

export function proxy() {
  const response = NextResponse.next();
  response.headers.set("link", '</middleware.css>; rel="preload"; as="style"');
  return response;
}

export const config = {
  matcher: "/middleware-link",
};
