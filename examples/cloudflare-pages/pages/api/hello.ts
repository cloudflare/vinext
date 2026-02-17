import type { NextApiRequest, NextApiResponse } from "next";

export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  res.json({
    message: "Hello from Pages Router API on Workers!",
    runtime: typeof navigator !== "undefined" ? navigator.userAgent : "unknown",
  });
}
