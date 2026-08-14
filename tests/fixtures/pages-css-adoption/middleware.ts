import { NextResponse, type NextRequest } from "next/server";

export default function middleware(request: NextRequest) {
  const response = NextResponse.next();
  const nonce = request.nextUrl.searchParams.get("nonce");
  if (nonce) {
    response.headers.set(
      "content-security-policy",
      `script-src 'nonce-${nonce}' 'strict-dynamic';`,
    );
  }
  return response;
}
