import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";

export async function GET() {
  return Sentry.startSpan(
    {
      attributes: { "fixture.router": "app" },
      forceTransaction: true,
      name: "fixture.app.transaction",
      op: "fixture.request",
    },
    () =>
      Sentry.startSpan(
        {
          attributes: { "fixture.child": true },
          name: "fixture.app.child",
          op: "fixture.child",
        },
        () => NextResponse.json({ ok: true }),
      ),
  );
}
