import { NextResponse, type NextRequest } from "next/server";

// Without the pin cookie, / renders the (pin) root layout's /pin page while
// the address bar keeps /.
export function middleware(request: NextRequest) {
  if (request.cookies.get("pin")?.value === "9999") return NextResponse.next();
  return NextResponse.rewrite(new URL("/pin", request.url));
}

export const config = { matcher: "/" };
