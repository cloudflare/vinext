import type { NextApiRequest, NextApiResponse } from "next";

// middleware.ts sets its own cookie on this route. Next.js keeps middleware's
// cookie ahead of the handler's setHeader("Set-Cookie"), even when it throws.
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Set-Cookie", "h=1; Path=/");
  if (req.query.throw !== undefined) {
    throw new Error("Intentional API route error after setHeader");
  }
  res.status(200).json({ ok: true });
}
