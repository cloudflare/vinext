/**
 * Fixture for app-simple-routes test.
 * Ported from: test/e2e/app-dir/app-simple-routes/app/api/edge.json/route.ts
 */
import { NextRequest, NextResponse } from "next/server";

export const GET = (req: NextRequest) => {
  return NextResponse.json({
    pathname: req.nextUrl.pathname,
  });
};

export const runtime = "edge";
