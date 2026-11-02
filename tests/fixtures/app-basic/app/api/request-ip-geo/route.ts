import type { NextRequest } from "next/server";

/**
 * Echoes vinext's NextRequest.ip / NextRequest.geo extensions so tests can
 * check they ignore client-supplied IP and geo headers.
 */
export async function GET(request: NextRequest) {
  return Response.json({ ip: request.ip ?? null, geo: request.geo ?? null });
}
