import type { NextApiRequest, NextApiResponse } from "next";

export default function handler(_request: NextApiRequest, response: NextApiResponse) {
  response.setHeader("Cache-Control", "max-age=10");
  response.setHeader("CDN-Cache-Control", "max-age=3600");
  response.json({ browserCache: true });
}
