import { NextResponse } from "next/server";

// Tries to set the internal notFound marker on a page that renders fine.
export function middleware() {
  const response = NextResponse.next();
  response.headers.set("x-vinext-pages-not-found", "1");
  return response;
}

export const config = { matcher: ["/mw-marker"] };
