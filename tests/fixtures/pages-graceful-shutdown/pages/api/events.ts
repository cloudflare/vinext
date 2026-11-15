import type { NextApiRequest, NextApiResponse } from "next";

// A server-sent events handler that runs until the client goes away.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.write("data: hello\n\n");
  const interval = setInterval(() => res.write("data: ping\n\n"), 100);
  await new Promise((resolve) => req.on("close", resolve));
  clearInterval(interval);
}
