import { headers } from "next/headers";
import type { NextRequest } from "next/server";

export async function GET(request: NextRequest) {
  const requestHeaders = await headers();

  return Response.json({
    viewerRole: request.headers.get("x-viewer-role"),
    empty: request.headers.get("x-empty-from-middleware"),
    setCookie: request.headers.get("set-cookie"),
    headersApiViewerRole: requestHeaders.get("x-viewer-role"),
  });
}
