import type { NextApiRequest, NextApiResponse } from "next";

export default function handler(request: NextApiRequest, response: NextApiResponse) {
  response.setHeader("Cache-Control", "public, max-age=300, s-maxage=600");
  response.json({ visitor: request.query.visitor });
}
