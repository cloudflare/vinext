import type { NextApiRequest, NextApiResponse } from "next";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const { slug, ...query } = req.query;
  res.status(200).json({ slug, query });
}
