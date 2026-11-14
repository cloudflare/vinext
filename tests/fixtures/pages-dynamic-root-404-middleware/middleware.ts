import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const NOT_FOUND_MARKER = "x-vinext-prerender-not-found";

// Replaces the request headers with a set of its own, as Next.js's
// request-header override does. It drops Vinext's prerender 404 marker where
// the request has it, and adds it where the request does not: neither may
// change which page renders.
export function middleware(request: NextRequest) {
  const headers = new Headers({ "x-from-middleware": "1" });
  if (!request.headers.has(NOT_FOUND_MARKER)) headers.set(NOT_FOUND_MARKER, "1");
  return NextResponse.next({ request: { headers } });
}
