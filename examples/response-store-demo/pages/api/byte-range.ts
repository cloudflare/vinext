import type { NextApiRequest, NextApiResponse } from "next";

const payload = "0123456789";

// Answers a single `bytes=first-last` range with a 206 under an explicit
// shared-cache policy, and any other request with the whole payload.
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "public, max-age=10");
  res.setHeader("Cloudflare-CDN-Cache-Control", "max-age=3600");
  const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? "");
  const first = Number(range?.[1]);
  const last = Math.min(Number(range?.[2]), payload.length - 1);
  if (range && first <= last) {
    res.setHeader("Content-Range", `bytes ${first}-${last}/${payload.length}`);
    res.status(206).send(payload.slice(first, last + 1));
    return;
  }
  res.status(200).send(payload);
}
