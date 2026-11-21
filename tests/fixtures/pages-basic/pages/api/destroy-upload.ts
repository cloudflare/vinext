import type { NextApiRequest, NextApiResponse } from "next";

export const config = { api: { bodyParser: false } };

// Rejects an upload after its first chunk and reports how long req.destroy()
// took to emit close. The delay lets the next body read start first, so the
// destroy hits a read that only settles when the client sends more.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await new Promise((resolve) => req.once("data", resolve));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const closed = new Promise<void>((resolve) => req.once("close", resolve));
  const destroyedAt = Date.now();
  req.destroy();
  await closed;
  res.status(413).json({ closeMs: Date.now() - destroyedAt });
}
