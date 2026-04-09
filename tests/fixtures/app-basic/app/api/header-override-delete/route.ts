import { headers } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";

export async function GET(request: NextRequest) {
  const requestHeaders = await headers();

  return NextResponse.json({
    requestAuthorization: request.headers.get("authorization"),
    requestCookie: request.headers.get("cookie"),
    requestMiddlewareHeader: request.headers.get("x-from-middleware"),
    headersApiAuthorization: requestHeaders.get("authorization"),
    headersApiCookie: requestHeaders.get("cookie"),
    headersApiMiddlewareHeader: requestHeaders.get("x-from-middleware"),
  });
}
