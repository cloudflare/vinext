import type { NextRequest } from "next/server";

export const revalidate = 60;

// Reading the host is a dynamic API, so the explicit provider policy cannot
// put one host's response in the entry every host shares.
export function GET(request: NextRequest): Response {
  return Response.json(
    { host: request.nextUrl.hostname, renderId: crypto.randomUUID() },
    { headers: { "CDN-Cache-Control": "public, s-maxage=60" } },
  );
}
