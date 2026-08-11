import { getReactConditions } from "../../lib/react-conditions";
import type { NextApiRequest, NextApiResponse } from "next";

export default function reactConditionsApi(_req: NextApiRequest, res: NextApiResponse) {
  res.json(getReactConditions());
}
