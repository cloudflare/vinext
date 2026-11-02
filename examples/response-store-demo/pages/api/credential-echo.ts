import type { NextApiRequest, NextApiResponse } from "next";

const credentialHeaders = ["authorization", "cookie", "proxy-authorization", "x-api-key"];

// Echoes request credentials under an explicit shared-cache policy, so a stored
// response would replay one caller's credentials to another.
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Cache-Control", "public, max-age=10");
  res.setHeader("Cloudflare-CDN-Cache-Control", "max-age=3600");
  res.status(200).json({
    credentials: Object.fromEntries(
      credentialHeaders.map((name) => [name, req.headers[name] ?? null]),
    ),
    renderId: crypto.randomUUID(),
  });
}
