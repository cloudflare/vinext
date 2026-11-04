import type { NextApiRequest, NextApiResponse } from "next";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const names: string[] = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) names.push(req.rawHeaders[i].toLowerCase());
  res.status(200).json({ names });
}
