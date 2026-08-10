import type { NextApiHandler } from "next";

import { meterApiRoute } from "@atlas/beacon/meter-api-route";
import { draftGatewayHandler } from "@atlas/draft/draft-gateway";
import { CREDENTIAL_SCOPE, PRODUCT } from "@atlas/fixed/product";

const draftHandler: NextApiHandler = (req, res) =>
  draftGatewayHandler(req, res, {
    credentialScope: CREDENTIAL_SCOPE,
    product: PRODUCT,
  });

const handler = meterApiRoute(draftHandler);

export default handler;
