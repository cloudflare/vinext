/**
 * instrumentation.ts for app-basic test fixture.
 *
 * Next.js calls register() once at server startup and onRequestError()
 * whenever an unhandled error occurs during request handling.
 *
 * This file records calls into the shared instrumentation-state module
 * so that the /api/instrumentation-test route can expose the state for
 * e2e tests to assert against.
 */

import { markRegisterCalled, recordRequestError } from "./instrumentation-state";

export async function register(): Promise<void> {
  markRegisterCalled();
}

export async function onRequestError(
  error: Error,
  request: { path: string; method: string; headers: Record<string, string> },
  context: {
    routerKind: string;
    routePath: string;
    routeType: string;
  },
): Promise<void> {
  recordRequestError({
    message: error.message,
    path: request.path,
    method: request.method,
    routerKind: context.routerKind,
    routePath: context.routePath,
    routeType: context.routeType,
  });
}
