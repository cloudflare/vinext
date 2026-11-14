import { NextResponse } from "next/server";

// Replaces the request headers with a set of its own, which drops every
// header middleware does not name, as Next.js's request-header override does.
export function middleware() {
  return NextResponse.next({
    request: { headers: new Headers({ "x-from-middleware": "1" }) },
  });
}
