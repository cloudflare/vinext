import { NextResponse } from "next/server";
import { getReportedSentryErrors, resetSentryReports } from "../../../sentry-test-state";

export async function GET() {
  return NextResponse.json({
    errors: getReportedSentryErrors(),
  });
}

export async function DELETE() {
  resetSentryReports();
  return NextResponse.json({ ok: true });
}
