import { headers } from "next/headers";

export async function GET(request: Request) {
  const requestHeaders = await headers();
  return Response.json({
    authorization: request.headers.get("authorization"),
    logical: request.headers.get("x-added"),
    logicalFromHeadersApi: requestHeaders.get("x-added"),
    raw: request.headers.get("x-middleware-request-x-added"),
    rawFromHeadersApi: requestHeaders.get("x-middleware-request-x-added"),
  });
}
