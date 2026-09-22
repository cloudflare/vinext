import { NextResponse } from "next/server";
import {
  getReportedSentryErrors,
  getReportedSentryTransactions,
  resetSentryReports,
} from "../../../sentry-test-state";

export async function GET() {
  return NextResponse.json({
    errors: getReportedSentryErrors(),
    transactions: getReportedSentryTransactions(),
  });
}

export async function DELETE() {
  resetSentryReports();
  return NextResponse.json({ ok: true });
}
