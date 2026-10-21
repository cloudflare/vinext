import type { NextRequest } from "next/server";

export const revalidate = 3600;

// Control: current vinext deliberately keeps hostname-dependent responses out
// of ISR. A tenant-key proposal must preserve this default behavior.
export function GET(request: NextRequest) {
  return Response.json({ tenant: request.nextUrl.hostname, renderId: crypto.randomUUID() });
}
