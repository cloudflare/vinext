import type { NextApiRequest, NextApiResponse } from "next";

// middleware.ts re-issues the `session` cookie on this route (a sliding-expiry
// refresh). The handler's deletion must still be the last Set-Cookie for that
// name, as in Next.js, so logout takes effect.
export default function handler(_request: NextApiRequest, response: NextApiResponse) {
  const existing = response.getHeader("Set-Cookie");
  response.setHeader("Set-Cookie", [
    ...(Array.isArray(existing) ? existing : existing ? [String(existing)] : []),
    "session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ]);
  response.status(200).json({ ok: true });
}
