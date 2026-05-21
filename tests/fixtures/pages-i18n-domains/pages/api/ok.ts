// API route used by i18n locale-prefix tests.
// Mirrors Next.js test/e2e/middleware-redirects/app/pages/api/ok.js.
import type { NextApiRequest, NextApiResponse } from "next";

export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  res.status(200).send("ok");
}
