// Ported from Next.js:
// test/e2e/middleware-general/app/pages/api/edge-search-params.js
// https://github.com/vercel/next.js/blob/canary/test/e2e/middleware-general/app/pages/api/edge-search-params.js
export const config = {
  runtime: "edge",
};

type NextRequestLike = Request & { nextUrl: { searchParams: URLSearchParams } };

export default function handler(req: NextRequestLike): Response {
  return Response.json(Object.fromEntries(req.nextUrl.searchParams));
}
