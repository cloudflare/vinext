import { NextResponse, type NextRequest } from "next/server";

export function middleware(_request: NextRequest) {
  const response = NextResponse.next();
  response.headers.set(
    "content-security-policy",
    "script-src 'nonce-vinext-test-nonce' 'strict-dynamic';",
  );
  return response;
}

export const config = { matcher: ["/dynamic-preload"] };
