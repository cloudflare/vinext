import { NextResponse } from "next/server";

export function proxy() {
  const response = NextResponse.next();
  response.headers.set(
    "content-security-policy",
    "script-src 'nonce-vinext-test-nonce' 'strict-dynamic';",
  );
  return response;
}
