import type { NextApiRequest, NextApiResponse } from "next";

// Pages Router API route writing its response in chunks.
// Coverage: tests/e2e/cloudflare-workers/streams-lab.spec.ts
export default async function handler(_req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("content-type", "text/plain; charset=utf-8");
  for (let i = 0; i < 20; i++) {
    res.write(`chunk ${i} ✓\n`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  res.end("done\n");
}
