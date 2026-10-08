import type { NextApiRequest, NextApiResponse } from "next";

export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  res.setPreviewData({});
  res.status(200).end("preview enabled");
}
