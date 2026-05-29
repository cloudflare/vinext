// Ported from Next.js: test/e2e/edge-pages-support/app/pages/api/hello.js
// https://github.com/vercel/next.js/blob/canary/test/e2e/edge-pages-support/app/pages/api/hello.js
//
// Pages Router edge runtime API route. The handler receives a NextRequest
// (Fetch-style) instead of (req, res), and must return a Web Response.
// Regression coverage for cloudflare/vinext#1338 — edge runtime API routes
// were reported as returning 500 against the Next.js deploy suite.
export const config = {
  runtime: "edge",
};

type NextRequestLike = Request & { nextUrl: { searchParams: URLSearchParams } };

export default async function handler(req: NextRequestLike): Promise<Response> {
  return new Response(
    JSON.stringify({
      hello: "world",
      query: Object.fromEntries(req.nextUrl.searchParams),
    }),
    { headers: { "content-type": "application/json" } },
  );
}
