import type { NextApiRequest, NextApiResponse } from "next";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  res.json({
    country: req.headers["cf-ipcountry"] ?? null,
    message: "Hello from Pages Router API on Workers!",
    runtime: typeof navigator !== "undefined" ? navigator.userAgent : "unknown",
  });
}
