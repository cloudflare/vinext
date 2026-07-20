import type { NextApiRequest, NextApiResponse } from "next";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<{ revalidated: boolean }>,
) {
  try {
    const path = typeof req.query.path === "string" ? req.query.path : "/revalidate-target";
    await res.revalidate(path, {
      unstable_onlyGenerated: req.query.onlyGenerated === "1",
    });
    res.json({ revalidated: true });
  } catch {
    res.status(500).json({ revalidated: false });
  }
}
