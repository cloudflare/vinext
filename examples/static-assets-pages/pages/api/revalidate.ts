import type { NextApiRequest, NextApiResponse } from "next";

export default async function revalidate(_req: NextApiRequest, res: NextApiResponse) {
  // A local E2E control with a fixed path, never a public revalidation endpoint.
  if (process.env.VINEXT_E2E_CONTROLS !== "1") return res.status(404).end();
  await res.revalidate("/posts/first");
  res.json({ revalidated: true });
}
