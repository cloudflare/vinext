import { NextResponse } from "next/server";

export const dynamic = "force-static";

export function GET() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set("published", "no");
  return response;
}
