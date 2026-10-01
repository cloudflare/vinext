import type { NextRequest } from "next/server";

export const config = {
  runtime: "edge",
};

export default function handler(request: NextRequest) {
  return Response.json({
    basePath: request.nextUrl.basePath,
    pathname: new URL(request.url).pathname,
  });
}
