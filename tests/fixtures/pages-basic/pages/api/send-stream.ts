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
  if (typeof req.query.status === "string") {
    // This stream never produces data: a 204/304 response must end without
    // waiting for it.
    res.status(Number(req.query.status)).send(new Readable({ read() {} }));
    return;
  }
  res.status(200).send(Readable.from(["hello ", "from ", "a stream"]));
}
