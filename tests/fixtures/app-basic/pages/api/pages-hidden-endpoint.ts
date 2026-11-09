// A Pages API route the client never receives a path for (issue #3624). A
// Pages `<Link>` to it still loads it as a document.
import type { NextApiRequest, NextApiResponse } from "next";

export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  res.status(200).json({ endpoint: "pages-hidden" });
}
