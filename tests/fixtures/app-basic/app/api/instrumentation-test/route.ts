/**
 * API route that exposes the current instrumentation state for e2e testing.
 *
 * GET /api/instrumentation-test
 *   Returns { registerCalled, errors } so Playwright tests can assert that
 *   instrumentation.ts register() was called on startup and that
 *   onRequestError() fired for any unhandled route errors.
 *
 * DELETE /api/instrumentation-test
 *   Resets the captured state so tests can start from a clean slate.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  getRegisterCalled,
  getCapturedErrors,
  resetInstrumentationState,
  getMiddlewareInvocationCount,
  getMiddlewareInvokedPaths,
  getMiddlewareInvocationCountById,
  getMiddlewareInvokedPathsById,
} from "../../../instrumentation-state";

export async function GET(request: NextRequest) {
  // When an `id` is supplied, report only the invocations recorded under that
  // unique test id — isolating the assertion from concurrent e2e traffic that
  // shares the global counter.
  const id = request.nextUrl.searchParams.get("id");
  return NextResponse.json({
    registerCalled: getRegisterCalled(),
    errors: getCapturedErrors(),
    middlewareInvocationCount: id
      ? getMiddlewareInvocationCountById(id)
      : getMiddlewareInvocationCount(),
    middlewareInvokedPaths: id ? getMiddlewareInvokedPathsById(id) : getMiddlewareInvokedPaths(),
  });
}

export async function DELETE() {
  resetInstrumentationState();
  return NextResponse.json({ ok: true });
}
