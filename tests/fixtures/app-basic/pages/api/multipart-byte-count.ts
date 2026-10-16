import type { NextApiRequest, NextApiResponse } from "next";

// Used by E2E: app-router-prod/multipart-late-routing.spec.ts and
// app-router-prod/server-action-late-routing.spec.ts
export const config = { api: { bodyParser: false } };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  let bytes = 0;
  for await (const chunk of req) bytes += chunk.length;
  res.status(200).json({ bytes });
}
