import type { NextApiRequest, NextApiResponse } from "next";

import { meterApiRoute } from "@atlas/beacon/meter-api-route";

/** Fields the relay is willing to pass through to the legacy platform. */
const FORWARDED_FIELDS = [
  "catalogRef",
  "itemRef",
  "zoneRef",
  "count",
  "part",
  "inscription",
  "dedication",
];

/**
 * Cookie-carrying proxy to the legacy platform, written in promise-chain
 * style: forwards a form-encoded POST upstream, reflects upstream Set-Cookie
 * headers back to the caller, and relays the JSON body.
 */
const relayHandler = (req: NextApiRequest, res: NextApiResponse) => {
  const upstream =
    process.env["ATLAS_RELAY_UPSTREAM_URL"] || "http://127.0.0.1:9";

  const body = new URLSearchParams();
  for (const field of FORWARDED_FIELDS) {
    const value = req.body?.[field];
    if (value != null) {
      body.set(field, String(value));
    }
  }

  fetch(`${upstream}/legacy/queue/submit`, {
    method: "POST",
    headers: {
      cookie: req.headers.cookie?.toString() || "",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  })
    .then((response) => {
      const cookies = response.headers.get("set-cookie");
      res.setHeader("set-cookie", cookies || "");
      return response.json();
    })
    .then((payload) => {
      res.status(200).json(payload);
    })
    .catch((error) => {
      console.log("Failure relaying queue submission", error?.message);
      res.status(500).json({ relayed: false });
    });
};

const handler = meterApiRoute(relayHandler);

export default handler;
