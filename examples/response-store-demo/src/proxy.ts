import { NextResponse, type NextRequest } from "next/server";

export function proxy(request: NextRequest) {
  if (!request.cookies.has("session")) {
    return NextResponse.redirect(new URL("/?gate=proxy", request.url));
  }
  return NextResponse.next();
}

export const config = { matcher: ["/dashboard", "/api/dashboard"] };
