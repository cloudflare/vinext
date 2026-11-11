import type { NextApiRequest, NextApiResponse } from "next";

// Node's ServerResponse rejects appendHeader() once write() sent the headers.
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  res.write("start:");
  try {
    res.appendHeader("x-late", "1");
    res.end("appended");
  } catch (error) {
    res.end(String((error as { code?: unknown }).code));
  }
}
