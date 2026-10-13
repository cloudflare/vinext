import type { NextApiRequest, NextApiResponse } from "next";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const path = typeof req.body?.path === "string" ? req.body.path : "";
  if (req.method !== "POST" || !path.startsWith("/")) {
    res.status(400).json({ error: "POST a leading-slash path" });
    return;
  }
  await res.revalidate(path);
  res.status(200).json({ revalidated: true, target: path });
}
