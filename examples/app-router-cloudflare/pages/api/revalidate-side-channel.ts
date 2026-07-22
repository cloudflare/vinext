import type { NextApiRequest, NextApiResponse } from "next";

export default async function handler(
  _req: NextApiRequest,
  res: NextApiResponse<{ revalidated: boolean }>,
) {
  try {
    await res.revalidate("/api/revalidation-host-sentinel");
    res.status(200).json({ revalidated: true });
  } catch {
    res.status(500).json({ revalidated: false });
  }
}
