import type { NextApiRequest, NextApiResponse } from "next";
import { isrCacheKey, isrSet } from "vinext/internal/server/isr-cache";

export default async function handler(_req: NextApiRequest, res: NextApiResponse) {
  const value = {
    kind: "PAGES",
    html: "<!doctype html><p>seeded cached representation</p>",
    pageData: {},
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Set-Cookie": "cache-secret=leaked; Path=/",
      Authorization: "Bearer cache-secret",
    },
    status: 200,
  } as const;
  // Dev does not expose a build ID; production does. Seed both fixture keys so
  // this endpoint remains useful in either server mode.
  await Promise.all([
    isrSet(isrCacheKey("pages", "/revalidate-parity-target"), value, 3600),
    isrSet(isrCacheKey("pages", "/revalidate-parity-target", "test-build-id"), value, 3600),
  ]);
  res.json({ seeded: true });
}
