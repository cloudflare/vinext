import type { NextApiRequest, NextApiResponse } from "next";

const VALUES: Record<string, unknown> = {
  null: null,
  undefined: undefined,
  zero: 0,
  number: 42,
  false: false,
  true: true,
};

/**
 * Sends the scalar named by `?value=` through `res.send()`, or `res.json()`
 * with `?method=json`. `?type=` sets a Content-Type first and `?status=` sets
 * the status.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (typeof req.query.type === "string") res.setHeader("Content-Type", req.query.type);
  res.status(Number(req.query.status ?? 200));
  const value = VALUES[String(req.query.value)];
  if (req.query.method === "json") res.json(value);
  else res.send(value);
}
