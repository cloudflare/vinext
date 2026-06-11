/**
 * API route exposing the module-level singleton probe for the
 * production-server double-evaluation regression test.
 *
 * GET /api/prod-singleton
 *   Returns { initializedBy }. With a healthy production server the bundle
 *   is evaluated exactly once, so initializedBy reflects the instrumentation
 *   register() write; a duplicate bundle instance reports null.
 *
 * The x-vinext-prod-singleton response header doubles as a marker literal so
 * tests can locate this route's chunk inside the minified build output.
 */

import { NextResponse } from "next/server";
import { getProdSingletonSnapshot } from "../../../prod-singleton-state";

export async function GET() {
  return NextResponse.json(getProdSingletonSnapshot(), {
    headers: { "x-vinext-prod-singleton": "1" },
  });
}
