import type { NextApiRequest, NextApiResponse } from "next";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const value = Array.isArray(req.query.value) ? req.query.value[0] : req.query.value;
  delete process.env.__VINEXT_DEPLOYMENT_ID;
  if (value) {
    process.env.NEXT_DEPLOYMENT_ID = value;
  } else {
    delete process.env.NEXT_DEPLOYMENT_ID;
  }
  res.json({ deploymentId: value ?? null });
}
