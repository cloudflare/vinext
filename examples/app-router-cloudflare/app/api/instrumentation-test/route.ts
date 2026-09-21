import { NextResponse } from "next/server";
import {
  isRegisterCalled,
  getCapturedErrors,
  getCapturedSpans,
  resetInstrumentationState,
} from "../../../instrumentation-state";

/**
 * API route that exposes the current instrumentation state for e2e testing.
 *
 * GET /api/instrumentation-test
 *   Returns { registerCalled, errors, spans } so Playwright tests can assert that
 *   instrumentation.ts register() was called on startup and that
 *   onRequestError() fired for any unhandled route errors.
 *
 * DELETE /api/instrumentation-test
 *   Resets request-error state while retaining spans captured during startup.
 */
export async function GET() {
  return NextResponse.json({
    registerCalled: isRegisterCalled(),
    errors: getCapturedErrors(),
    spans: getCapturedSpans(),
  });
}

export async function DELETE() {
  resetInstrumentationState();
  return NextResponse.json({ ok: true });
}
