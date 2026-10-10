import { NextResponse, type NextRequest } from "next/server";

const OUTSIDE_REWRITES: Record<string, string> = {
  "/mw-rewrite-outside": "/base/hello",
  "/mw-rewrite-edge-outside": "/base/api/edge",
};

// No matcher, so Next.js also runs this for absolute paths outside basePath.
export function middleware(request: NextRequest) {
  const { basePath, pathname } = request.nextUrl;
  const rewrite = basePath ? undefined : OUTSIDE_REWRITES[pathname];
  const response = rewrite
    ? NextResponse.rewrite(new URL(rewrite, request.url))
    : NextResponse.next();
  response.headers.set("x-mw", `${basePath || "(none)"}|${pathname}`);
  return response;
}
