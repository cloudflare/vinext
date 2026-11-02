import type { NextApiRequest, NextApiResponse } from "next";

// Used by Playwright: tests/e2e/pages-api-config-headers.ts. Next.js writes the
// next.config headers to `res` before the API handler runs, so the handler can
// read, extend and replace them.
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.query["replace-cookie"]) res.setHeader("Set-Cookie", "handler-cookie=1; Path=/");
  const link = res.getHeader("Link");
  res.setHeader("Link", `${link}, <https://example.com/doc>; rel="canonical"`);
  res.setHeader("x-config-override", "handler");
  if (req.query.throw) throw new Error("config-headers handler error");
  res.status(200).json({ link: link ?? null });
}
