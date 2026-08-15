import type { NextApiRequest, NextApiResponse } from "next";

import { meterApiRoute } from "@atlas/beacon/meter-api-route";
import { applyCachePolicy } from "@atlas/edge-policy/policy";

/**
 * Legacy gateway shim: the old platform's type-ahead endpoint is rewritten
 * here (see `rewrites()` in next.config), and the modern stack answers with
 * an intentionally-cacheable empty response.
 */
const typeAheadHandler = (_: NextApiRequest, res: NextApiResponse) => {
  applyCachePolicy({
    res,
    surrogateSeconds: 14400,
    browserSeconds: 600,
  });

  res.status(204).end();
};

const handler = meterApiRoute(typeAheadHandler);

export default handler;
