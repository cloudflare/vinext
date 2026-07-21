import type { NextApiRequest, NextApiResponse } from "next";
import { recordSentryErrorReport } from "../../../sentry-test-state";

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    return res.status(405).end();
  }

  const projectId = Array.isArray(req.query.projectId)
    ? req.query.projectId[0]
    : req.query.projectId;
  let envelope = "";
  const decoder = new TextDecoder();
  for await (const chunk of req) {
    envelope += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
  }
  envelope += decoder.decode();

  recordSentryErrorReport(projectId ?? "", envelope);
  return res.status(200).json({ ok: true });
}
