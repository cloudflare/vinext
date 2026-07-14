import { NextResponse } from "next/server";

export function proxy() {
  const response = NextResponse.next();
  response.headers.set("Cache-Control", "public, max-age=3600");
  response.headers.set("CDN-Cache-Control", "public, max-age=3600");
  response.headers.set("Cloudflare-CDN-Cache-Control", "public, max-age=3600");
  response.headers.set("Cache-Tag", "action-process-fixture");
  return response;
}
