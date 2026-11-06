import type { NextApiRequest, NextApiResponse } from "next";

export default function preview(_req: NextApiRequest, res: NextApiResponse) {
  // A local E2E control only; deployed builds never expose preview mode.
  if (process.env.VINEXT_E2E_CONTROLS !== "1") return res.status(404).end();
  res.setPreviewData({});
  res.json({ preview: true });
}
