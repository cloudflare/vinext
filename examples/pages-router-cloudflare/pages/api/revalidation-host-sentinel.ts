import type { NextApiRequest, NextApiResponse } from "next";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.headers["x-vinext-revalidate-host"] !== undefined) {
    res.status(409).json({ logicalHostVisible: true });
    return;
  }
  res.status(200).json({ logicalHostVisible: false });
}
