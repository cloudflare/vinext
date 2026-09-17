import * as Sentry from "@sentry/nextjs";
import type { NextApiRequest, NextApiResponse } from "next";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const slug = Array.isArray(req.query.slug) ? req.query.slug[0] : req.query.slug;
  return Sentry.startSpan(
    {
      attributes: { "fixture.router": "pages", "fixture.slug": slug ?? "" },
      name: "fixture.pages.child",
      op: "fixture.child",
    },
    () => res.status(200).json({ ok: true, slug }),
  );
}
