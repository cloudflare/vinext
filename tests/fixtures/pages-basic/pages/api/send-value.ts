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
 * Sends the scalar named by `?value=` through `res.send()`. `?type=` sets a
 * Content-Type first, to check a nullish send keeps it.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (typeof req.query.type === "string") res.setHeader("Content-Type", req.query.type);
  res.status(200).send(VALUES[String(req.query.value)]);
}
