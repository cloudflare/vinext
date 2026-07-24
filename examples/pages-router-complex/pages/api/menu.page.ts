import type { NextApiHandler } from "next";

import { meterApiRoute } from "@atlas/beacon/meter-api-route";
import { fetchNavTree } from "@atlas/chrome/fetch-chrome-bundle";
import { CREDENTIAL_SCOPE } from "@atlas/fixed/product";
import { zoneFromRouteQuery } from "@atlas/zones/zone";

/** Client-side refresh endpoint for the masthead menu. */
const menuHandler: NextApiHandler = async (req, res) => {
  const zone = zoneFromRouteQuery(req.query);

  const navTree = await fetchNavTree({
    zone,
    draft: false,
    credentialScope: CREDENTIAL_SCOPE,
  });
  if (navTree) {
    res.status(200).json(navTree);
  } else {
    res.status(500).json({ errorMessage: "failed to fetch menu data" });
  }
};

const handler = meterApiRoute(menuHandler);

export default handler;
