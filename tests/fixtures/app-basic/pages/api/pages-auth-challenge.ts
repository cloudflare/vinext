import type { NextApiRequest, NextApiResponse } from "next";

// middleware.ts adds its own challenges to this route. A Next.js Pages API
// handler writes to the response that already holds middleware's headers, so
// its challenge replaces middleware's instead of joining it.
export default function handler(_request: NextApiRequest, response: NextApiResponse) {
  response.setHeader("WWW-Authenticate", 'Bearer realm="handler"');
  response.status(401).end("Unauthorized");
}
