import { NextResponse } from "next/server";
import { recordSentryErrorReport } from "../../../../sentry-test-state";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  recordSentryErrorReport(projectId, await request.text());
  return NextResponse.json({ ok: true });
}
