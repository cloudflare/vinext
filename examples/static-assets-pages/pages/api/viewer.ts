import type { NextApiRequest, NextApiResponse } from "next";

export default function viewer(_req: NextApiRequest, res: NextApiResponse) {
  res.json({ viewer: "anonymous" });
}
