import type { NextApiRequest, NextApiResponse } from "next";
export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.status(200).json({ renderId: crypto.randomUUID() });
}
