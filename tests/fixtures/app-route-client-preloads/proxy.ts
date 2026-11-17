import { NextResponse, type NextRequest } from "next/server";

export function proxy(request: NextRequest) {
  const response = NextResponse.next();
  // `?no-csp` renders without a CSP nonce.
  if (request.nextUrl.searchParams.has("no-csp")) return response;
  response.headers.set(
    "content-security-policy",
    "script-src 'nonce-vinext-test-nonce' 'strict-dynamic';",
  );
  return response;
}
