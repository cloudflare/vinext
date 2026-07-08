import type { NextRequest } from "next/server";

// Use fallback rewrites to redirect all /:teamSlug URLs through the App Router.
export async function GET(
  request: NextRequest,
  {
    params,
  }: {
    params: Promise<{
      path: string;
    }>;
  },
): Promise<Response> {
  request.nextUrl.pathname = `/app-future/en/${(await params).path}`;
  return fetch(request.nextUrl, {
    headers: new Headers({
      cookie: request.headers.get("cookie") ?? "",
    }),
  }).then(async (res) => {
    const resHeaders = new Headers(res.headers);
    resHeaders.delete("content-encoding");
    return new Response(res.body, { status: res.status, headers: resHeaders });
  });
}
