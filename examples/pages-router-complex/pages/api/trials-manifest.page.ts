import type { NextApiHandler } from "next";

import { meterApiRoute } from "@atlas/beacon/meter-api-route";
import { trialsManifest } from "@atlas/trials/trials";

/** Serves the trials manifest fetched by the _document bootstrap snippet. */
const manifestHandler: NextApiHandler = (req, res) => {
  if (!req.query["key"]) {
    res.status(400).json({ errorMessage: "key is required" });
    return;
  }
  res.status(200).json(trialsManifest());
};

const handler = meterApiRoute(manifestHandler);

export default handler;
