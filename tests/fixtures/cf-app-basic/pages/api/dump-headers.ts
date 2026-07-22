import type { NextApiRequest, NextApiResponse } from "next";

/**
 * Echoes the request headers as JSON. Used to assert that middleware-mutated
 * request headers reach a Pages Router API route in a hybrid app/ + pages/ app.
 * Regression coverage for #1520.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  res.status(200).json(req.headers);
}
