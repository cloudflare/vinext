import type { NextApiRequest, NextApiResponse } from "next";

// Next.js ignores setHeader() once write() sent the headers instead of
// throwing like a plain Node ServerResponse.
export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  res.write("start:");
  try {
    res.setHeader("x-late", "1");
    res.end("ignored");
  } catch (error) {
    res.end(String((error as { code?: unknown }).code));
  }
}
