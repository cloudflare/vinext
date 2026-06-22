import { NextResponse, type NextRequest } from "next/server";
import value from "foo";
import baseValue from "base-value";

export function middleware(_request: NextRequest) {
  return NextResponse.json({ value, baseValue });
}

export const config = {
  matcher: "/middleware-result",
};
