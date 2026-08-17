import type { NextApiHandler } from "next";

import { meterApiRoute } from "@atlas/beacon/meter-api-route";
import { lookupStore } from "@atlas/memo/memo-cache";

type PurgePayload = { registry: string; op: string; keyHint?: string };

const isValidPayload = (body: unknown): body is PurgePayload =>
  !!body &&
  typeof body === "object" &&
  "registry" in body &&
  typeof body.registry === "string" &&
  body.registry.length > 0 &&
  "op" in body &&
  typeof body.op === "string" &&
  body.op.length > 0 &&
  ("keyHint" in body ? typeof body.keyHint === "string" : true);

/**
 * Operational eviction endpoint: bearer-gated, evicts memoised results by
 * `<registry>:<op>[:<keyHint>]` prefix.
 */
const purgeHandler: NextApiHandler = async (req, res) => {
  if (
    !process.env.ATLAS_PURGE_BEARER ||
    req.headers?.authorization !== process.env.ATLAS_PURGE_BEARER
  ) {
    return res.status(401).end();
  }

  if (!isValidPayload(req.body)) {
    res.status(400).end();
    return;
  }

  const store = lookupStore(req.body.registry);
  if (!store) {
    res.status(404).end();
    return;
  }

  const prefix = [req.body.registry, req.body.op, req.body.keyHint]
    .filter((v) => !!v)
    .join(":");

  const evicted = await store.evictByPrefix(prefix);
  if (!evicted) {
    res.status(500).end();
    return;
  }

  res.status(200).end();
};

const handler = meterApiRoute(purgeHandler);

export default handler;
