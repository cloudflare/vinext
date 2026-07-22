import type { NextApiRequest, NextApiResponse } from "next";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  res.json({
    host: req.headers.host ?? null,
    logicalHost: req.headers["x-vinext-revalidate-host"] ?? null,
  });
}
