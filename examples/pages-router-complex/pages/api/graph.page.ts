import type { NextApiHandler } from "next";

import { meterApiRoute } from "@atlas/beacon/meter-api-route";
import { executeGraphOp } from "@atlas/graph-handle/ops";

/** Browser-facing data-edge endpoint used by useGraphOp on cache misses. */
const graphHandler: NextApiHandler = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).end();
    return;
  }

  const { op, variables } = req.body ?? {};
  if (typeof op !== "string") {
    res.status(400).json({ errorMessage: "op is required" });
    return;
  }

  try {
    const data = await executeGraphOp(op, variables ?? {});
    res.status(200).json({ data });
  } catch {
    res.status(400).json({ errorMessage: "unknown op" });
  }
};

const handler = meterApiRoute(graphHandler);

export default handler;
