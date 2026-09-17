import * as Sentry from "@sentry/nextjs";
import type { NextApiRequest, NextApiResponse } from "next";

export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  return Sentry.startSpan(
    {
      attributes: { "fixture.router": "pages" },
      forceTransaction: true,
      name: "fixture.pages.transaction",
      op: "fixture.request",
    },
    () =>
      Sentry.startSpan(
        {
          attributes: { "fixture.child": true },
          name: "fixture.pages.child",
          op: "fixture.child",
        },
        () => res.status(200).json({ ok: true }),
      ),
  );
}
