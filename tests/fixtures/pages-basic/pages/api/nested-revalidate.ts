import type { NextApiRequest, NextApiResponse } from "next";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<{ nestedRejected: boolean }>,
) {
  const selfTarget = req.query.self === "1";
  try {
    await res.revalidate(selfTarget ? "/api/nested-revalidate?self=1" : "/revalidate-reason");
    res.status(200).json({ nestedRejected: false });
  } catch {
    const isInternal = typeof req.headers["x-prerender-revalidate"] === "string";
    res.status(isInternal ? 409 : 200).json({ nestedRejected: true });
  }
}
