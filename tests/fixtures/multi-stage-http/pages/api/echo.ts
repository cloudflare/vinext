import type { NextApiRequest, NextApiResponse } from "next";

export default function handler(request: NextApiRequest, response: NextApiResponse) {
  response.setHeader("Cache-Control", "no-store");
  response.status(200).json({
    body: request.body,
    renderToken: crypto.randomUUID(),
  });
}
