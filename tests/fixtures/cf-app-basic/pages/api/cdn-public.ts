import type { NextApiRequest, NextApiResponse } from "next";

export default function handler(_request: NextApiRequest, response: NextApiResponse) {
  response.setHeader("Cache-Control", "public, s-maxage=60");
  response.json({ public: true });
}
