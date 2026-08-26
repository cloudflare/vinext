import { getReactConditions } from "../../lib/react-conditions";
import type { NextApiRequest, NextApiResponse } from "next";

// Ported from Next.js:
// test/e2e/react-version/pages/api/pages-api-edge-url-dep.js
// https://github.com/vercel/next.js/blob/canary/test/e2e/react-version/pages/api/pages-api-edge-url-dep.js
void import(new URL("./react-conditions.css", import.meta.url).href);

export default function reactConditionsApi(_req: NextApiRequest, res: NextApiResponse) {
  res.json(getReactConditions());
}
