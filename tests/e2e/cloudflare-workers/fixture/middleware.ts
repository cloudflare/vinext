import { NextResponse, type NextRequest } from "next/server";
import { animatedImageSources } from "./image-test-animated-sources";

let imageSourceDispatchCount = 0;
let imageSourceMethod = "";

const imageBytes = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc, 0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
]);

export function middleware(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl;
  if (pathname === "/image-test/reset") {
    imageSourceDispatchCount = 0;
    imageSourceMethod = "";
    return Response.json({ ok: true });
  }
  if (pathname === "/image-test/state") {
    return Response.json({ count: imageSourceDispatchCount, method: imageSourceMethod });
  }
  if (pathname !== "/image-test/source.png") return NextResponse.next();

  imageSourceDispatchCount += 1;
  imageSourceMethod = request.method;
  if (searchParams.has("auth")) {
    return new Response("Authentication required", { status: 401 });
  }
  if (searchParams.has("spoof")) {
    return new Response("Authentication required", {
      status: 401,
      headers: { "content-type": "image/png" },
    });
  }
  const animated = searchParams.get("animated") as keyof typeof animatedImageSources | null;
  const animatedSource = animated ? animatedImageSources[animated] : undefined;
  const body = animatedSource
    ? animatedSource.bytes
    : searchParams.has("oversize")
      ? new Uint8Array([...imageBytes, ...new Uint8Array(64)])
      : imageBytes;
  return new Response(body, {
    headers: {
      "cache-control": "public, max-age=200",
      etag: '"middleware-source"',
      "content-type": animatedSource
        ? animatedSource.contentType
        : searchParams.has("wrong-type")
          ? "text/html"
          : "application/octet-stream",
    },
  });
}

export const config = { matcher: ["/image-test/:path*"] };
