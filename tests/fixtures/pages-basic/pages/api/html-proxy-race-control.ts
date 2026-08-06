import type { NextApiRequest, NextApiResponse } from "next";
import { getHtmlProxyRaceStatus, releaseHtmlProxyRace } from "../../html-proxy-race-state";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const id = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
  if (!id) {
    res.status(400).json({ error: "missing race id" });
    return;
  }

  const action = Array.isArray(req.query.action) ? req.query.action[0] : req.query.action;
  if (action === "release") releaseHtmlProxyRace(id);
  res.status(200).json(getHtmlProxyRaceStatus(id));
}
