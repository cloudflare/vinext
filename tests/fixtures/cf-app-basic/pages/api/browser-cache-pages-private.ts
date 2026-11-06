import type { NextApiRequest, NextApiResponse } from "next";
export default function handler(request: NextApiRequest, response: NextApiResponse) {
  response.setHeader("Cache-Control", "private, max-age=300");
  response.setHeader("X-Private-Visitor", request.headers["x-private-visitor"] ?? "anonymous");
  response.json({ browserCache: true });
}
