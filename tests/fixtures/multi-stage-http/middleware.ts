import { NextResponse, type NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const aliasMatch = request.nextUrl.pathname.match(/^\/alias-(.+)$/);
  const response = aliasMatch
    ? NextResponse.rewrite(new URL(`/${aliasMatch[1]}`, request.url))
    : NextResponse.next();
  if (request.nextUrl.pathname === "/stage-asset.txt") {
    response.headers.set("content-encoding", "gzip");
    response.headers.set("content-length", "999");
    response.headers.set("content-type", "application/wrong");
    response.headers.set("transfer-encoding", "chunked");
  }
  response.headers.set(
    "x-http-stage-visitor",
    request.headers.get("x-test-visitor") ?? "anonymous",
  );
  return response;
}
