import type { NextApiRequest, NextApiResponse } from "next";

import { wasBootHookCalled } from "../../boot-state";

export default function handler(_: NextApiRequest, res: NextApiResponse) {
  res.status(200).json({ status: "up", bootHookRan: wasBootHookCalled() });
}
