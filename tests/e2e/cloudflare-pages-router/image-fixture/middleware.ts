import { NextResponse, type NextRequest } from "next/server";

let count = 0;
let method = "";
const image = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc, 0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
]);

export function middleware(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl;
  if (pathname === "/image-test/reset") {
    count = 0;
    method = "";
    return Response.json({ ok: true });
  }
  if (pathname === "/image-test/state") return Response.json({ count, method });
  if (pathname !== "/image-test/source.png") return NextResponse.next();
  count += 1;
  method = request.method;
  if (searchParams.has("spoof")) {
    return new Response("Authentication required", {
      status: 401,
      headers: { "content-type": "image/png" },
    });
  }
  const body = searchParams.has("oversize")
    ? new Uint8Array([...image, ...new Uint8Array(64)])
    : image;
  return new Response(body, {
    headers: {
      "cache-control": "public, max-age=200",
      "content-type": "text/html",
    },
  });
}

export const config = { matcher: ["/image-test/:path*"] };
