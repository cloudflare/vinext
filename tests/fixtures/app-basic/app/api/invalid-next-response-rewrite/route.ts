import { NextResponse } from "next/server";

export function GET(request: Request) {
  return NextResponse.rewrite(new URL("/api/hello", request.url));
}
