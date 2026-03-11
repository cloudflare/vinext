import { NextResponse } from "next/server";

export async function GET() {
  // The middleware sets x-mw-ran and x-mw-pathname as response headers.
  // These are merged into the final response by vinext's middleware pipeline.
  // This route handler just returns a simple response; the middleware headers
  // will be appended to it by the framework.
  return NextResponse.json({ ok: true });
}
