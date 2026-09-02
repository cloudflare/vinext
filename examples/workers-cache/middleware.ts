import { NextResponse, type NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const response = NextResponse.next();
  response.headers.set(
    "x-workers-cache-visitor",
    request.headers.get("x-test-visitor-id") ?? "anonymous",
  );
  return response;
}

export const config = { matcher: ["/prewarm-target", "/pages-prewarm"] };
