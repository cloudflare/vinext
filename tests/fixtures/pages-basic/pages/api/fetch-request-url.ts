import type { NextApiRequest, NextApiResponse } from "next";

// Forwards request input into the URL of an outgoing fetch, as a proxying API
// route would. The fetches run outside any page render.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const id = String(req.query.id ?? "");
  const origin = `http://${req.headers.host}`;
  await fetch(`${origin}/api/hello?plain=${encodeURIComponent(id)}`);
  await fetch(`${origin}/api/hello?no-store=${encodeURIComponent(id)}`, { cache: "no-store" });
  res.status(200).json({ id });
}
