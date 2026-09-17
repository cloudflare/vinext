import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return Sentry.startSpan(
    {
      attributes: { "fixture.router": "app", "fixture.slug": slug },
      name: "fixture.app.child",
      op: "fixture.child",
    },
    () => NextResponse.json({ ok: true, slug }),
  );
}
