import { NextResponse } from "next/server";
import { unstable_cache } from "next/cache";
import { headers as nextHeaders, draftMode } from "next/headers";

const getCachedValue = unstable_cache(
  async () => Math.random().toString(),
  ["middleware-cache-probe"],
);

export async function middleware(request: import("next/server").NextRequest) {
  const headersFromRequest = new Headers(request.headers);
  const headersFromNext = await nextHeaders();
  headersFromRequest.set("x-from-middleware", "hello-from-middleware");

  if (
    headersFromRequest.get("x-from-client") &&
    headersFromNext.get("x-from-client") !== headersFromRequest.get("x-from-client")
  ) {
    throw new Error("Expected headers from client to match");
  }

  if (request.nextUrl.searchParams.get("draft")) {
    (await draftMode()).enable();
  }

  const removeHeaders = request.nextUrl.searchParams.get("remove-headers");
  if (removeHeaders) {
    for (const key of removeHeaders.split(",")) {
      headersFromRequest.delete(key);
    }
  }

  const updateHeaders = request.nextUrl.searchParams.get("update-headers");
  if (updateHeaders) {
    for (const kv of updateHeaders.split(",")) {
      const [key, value] = kv.split("=");
      headersFromRequest.set(key, value);
    }
  }

  if (request.nextUrl.pathname === "/preloads") {
    return NextResponse.next({
      headers: {
        link: '<https://example.com/page>; rel="alternate"; hreflang="en"',
      },
    });
  }

  if (request.nextUrl.pathname === "/unstable-cache") {
    const value = await getCachedValue();
    return NextResponse.json({ value });
  }

  if (request.nextUrl.pathname === "/test-location-header") {
    return NextResponse.json(
      { foo: "bar" },
      {
        headers: {
          location: "https://next-data-api-endpoint.vercel.app/api/random",
        },
      },
    );
  }

  return NextResponse.next({
    request: {
      headers: headersFromRequest,
    },
  });
}

export const config = {
  matcher: [
    "/headers",
    "/api/dump-headers-serverless",
    "/preloads",
    "/unstable-cache",
    "/test-location-header",
  ],
};
