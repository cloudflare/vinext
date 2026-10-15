import { NextResponse, type NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const response = NextResponse.next();
  // Exposes the domain locale middleware resolves from the request's Host.
  response.headers.set("x-mw-domain-locale", request.nextUrl.domainLocale?.domain ?? "");
  return response;
}
