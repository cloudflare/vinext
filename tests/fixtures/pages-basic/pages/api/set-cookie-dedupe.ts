import type { NextApiRequest, NextApiResponse } from "next";

// Next.js dedupes the values passed to setHeader("Set-Cookie"), including
// against middleware's cookies, but keeps a raw appendHeader() duplicate.
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Set-Cookie", ["d=1; Path=/", "d=1; Path=/"]);
  if (req.query.append !== undefined) res.appendHeader("Set-Cookie", "d=1; Path=/");
  res.status(200).json({ ok: true });
}
