// Ported from Next.js: test/integration/server-asset-modules/pages/api/test.js
// https://github.com/vercel/next.js/blob/canary/test/integration/server-asset-modules/pages/api/test.js
//
// Node.js API route that reads a file through `new URL(<file>, import.meta.url)`.
// The URL must stay a readable `file:` URL on Node while the same reference is
// also fetchable from edge routes (see pages/api/edge-blob-assets.ts).
import { readFile } from "node:fs/promises";
import type { NextApiRequest, NextApiResponse } from "next";

export default async function handler(_req: NextApiRequest, res: NextApiResponse) {
  const fileUrl = new URL("../../server-assets/text-file.txt", import.meta.url);
  res.json({ content: await readFile(fileUrl, "utf8") });
}
