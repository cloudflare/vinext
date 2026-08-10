import type { NextApiHandler, NextApiRequest, NextApiResponse } from "next";

import { bumpRequestTally, looksLikeCrawler } from "./tally";

export const meterApiRoute = <T = Record<string, unknown>>(
  handler: NextApiHandler<T>,
) => {
  const meteredHandler: NextApiHandler<T> = async (
    req: NextApiRequest,
    res: NextApiResponse<T>,
  ) => {
    const fromCrawler = looksLikeCrawler(req.headers["user-agent"]);
    const path = req.url;
    const method = req.method;

    const record = (statusCode: number) =>
      path &&
      method &&
      bumpRequestTally({
        path,
        method,
        fromCrawler,
        statusCode,
      });

    try {
      await handler(req, res);

      record(res.statusCode);
    } catch (error) {
      record(500);

      throw error;
    }
  };

  return meteredHandler;
};
