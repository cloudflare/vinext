import type { NextRequest } from "next/server";

export const revalidate = 60;

// Selects tenant data by hostname. The ISR key holds only the pathname, so the
// hostname read must keep this response out of the shared cache.
export function GET(request: NextRequest) {
  return Response.json({ tenant: request.nextUrl.hostname });
}
