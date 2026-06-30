import type { NextApiRequest, NextApiResponse } from "next";
import { getReportedSentryErrors, resetSentryReports } from "../../sentry-test-state";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "DELETE") {
    resetSentryReports();
    return res.status(200).json({ ok: true });
  }

  return res.status(200).json({
    errors: getReportedSentryErrors(),
  });
}
