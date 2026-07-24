import type { NextApiRequest, NextApiResponse } from "next";

import type { DraftLandingOpts } from "./resolve-draft-landing";
import { resolveDraftLanding } from "./resolve-draft-landing";

const wantsDraftOn = (req: NextApiRequest) => req.query?.["draft"] !== "off";

export const draftGatewayHandler = async (
  req: NextApiRequest,
  res: NextApiResponse,
  opts: DraftLandingOpts,
) => {
  if (wantsDraftOn(req)) {
    res.setDraftMode({ enable: true });
  } else {
    res.setDraftMode({ enable: false });
  }

  const landing = await resolveDraftLanding(req.query, {
    ...opts,
    requestUrl: req.url,
  });
  if (
    typeof landing !== "string" ||
    !landing.startsWith("/") ||
    landing.startsWith("//")
  ) {
    res.status(400).end("Refusing to land draft on that URL");
    return;
  }

  res.redirect(landing);
};
