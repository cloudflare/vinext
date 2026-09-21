import { NextResponse } from "next/server";
import { recordSentryEnvelope } from "../../../../sentry-test-state";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  recordSentryEnvelope(projectId, await request.text());
  return NextResponse.json({ ok: true });
}
