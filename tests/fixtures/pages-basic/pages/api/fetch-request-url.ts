import type { NextApiRequest, NextApiResponse } from "next";

// Forwards request input into the URL of an outgoing fetch, as a proxying API
// route would. The fetches run outside any page render; the upstream is a
// closed local port, so they only need to start.
const UPSTREAM = "http://127.0.0.1:9/upstream";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const id = encodeURIComponent(String(req.query.id ?? ""));
  await fetch(`${UPSTREAM}?plain=${id}`).catch(() => {});
  await fetch(`${UPSTREAM}?no-store=${id}`, { cache: "no-store" }).catch(() => {});
  res.status(200).json({ id: req.query.id });
}
