import type { NextApiRequest, NextApiResponse } from "next";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  res.status(200).json({
    viewerRole: req.headers["x-viewer-role"] ?? null,
    empty: req.headers["x-empty-from-middleware"] ?? null,
    setCookie: req.headers["set-cookie"] ?? null,
  });
}
