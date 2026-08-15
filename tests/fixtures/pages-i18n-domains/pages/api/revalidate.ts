import type { NextApiRequest, NextApiResponse } from "next";
import { getDomainRevalidateState, type DomainRevalidateState } from "../../revalidate-state";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<{ revalidated: boolean; state?: DomainRevalidateState }>,
) {
  try {
    const path = typeof req.query.path === "string" ? req.query.path : "/isr-about";
    await res.revalidate(path, {
      unstable_onlyGenerated: req.query.onlyGenerated === "1",
    });
    res.json({
      revalidated: true,
      ...(req.query.includeState === "1" ? { state: getDomainRevalidateState() } : {}),
    });
  } catch {
    res.status(500).json({ revalidated: false });
  }
}
