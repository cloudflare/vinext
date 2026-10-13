import type { NextApiRequest, NextApiResponse } from "next";

export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  res.status(200).json({ calls: globalThis.__vinextStaticPathsCalls ?? 0 });
}
