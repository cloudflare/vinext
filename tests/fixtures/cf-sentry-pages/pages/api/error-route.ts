import type { NextApiRequest, NextApiResponse } from "next";

export default function handler(_req: NextApiRequest, _res: NextApiResponse) {
  throw new Error("Intentional Sentry Pages Router error");
}
