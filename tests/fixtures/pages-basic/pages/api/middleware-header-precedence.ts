import type { NextApiRequest, NextApiResponse } from "next";

// middleware.ts sets every header below (plus Proxy-Authenticate and a
// cookie) before this Node API handler runs. As in Next.js, the handler's
// own setHeader() replaces a middleware value, a header it leaves alone keeps
// middleware's value, and middleware's cookie stays ahead of the handler's.
// `?throw=headers` fails after setting them: the 500 keeps the handler's too.
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("WWW-Authenticate", 'Bearer realm="handler"');
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("x-header-precedence", "handler");
  res.setHeader("Set-Cookie", "handler-cookie=1; Path=/");
  if (req.query.throw === "headers") throw new Error("middleware-header-precedence failure");
  res.status(401).end("unauthorized");
}
