import type { NextApiRequest, NextApiResponse } from "next";

// middleware.ts sets every header below (plus Proxy-Authenticate and a
// cookie) before this Node API handler runs. As in Next.js, the handler's
// own setHeader() replaces a middleware value, a header it leaves alone keeps
// middleware's value, and middleware's cookie stays ahead of the handler's.
export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("WWW-Authenticate", 'Bearer realm="handler"');
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("x-header-precedence", "handler");
  res.setHeader("Set-Cookie", "handler-cookie=1; Path=/");
  res.status(401).end("unauthorized");
}
