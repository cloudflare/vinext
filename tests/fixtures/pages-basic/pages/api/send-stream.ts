import type { NextApiRequest, NextApiResponse } from "next";
import { Readable } from "node:stream";

/**
 * API route that passes a Node Readable to res.send(). Next.js pipes the
 * stream into the response and defaults Content-Type to
 * application/octet-stream unless the handler already set one.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (typeof req.query.contentType === "string") {
    res.setHeader("Content-Type", req.query.contentType);
  }
  res.status(200).send(Readable.from(["hello ", "from ", "a stream"]));
}
