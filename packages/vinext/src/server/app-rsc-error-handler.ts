import { createRscOnErrorHandler } from "./app-rsc-errors.js";

type ReportRequestError = (
  error: Error,
  requestInfo: { path: string; method: string; headers: Record<string, string> },
  errorContext: { routerKind: "App Router"; routePath: string; routeType: "render" },
) => void;

/**
 * Build a per-request RSC error handler that extracts request metadata from
 * the incoming Web `Request`, wires it into a `createRscOnErrorHandler` call,
 * and binds the configured `reportRequestError` reporter.
 *
 * Pure factory: takes all deps explicitly — no closure over module-level state.
 */
export function createAppRscOnErrorHandler(
  reportRequestError: ReportRequestError,
  request: Request,
  pathname: string,
  routePath: string,
): (error: unknown) => string | undefined {
  const requestHeaders: Record<string, string> = Object.fromEntries(request.headers.entries());
  const requestInfo = {
    path: pathname,
    method: request.method,
    headers: requestHeaders,
  };
  const errorContext = {
    routerKind: "App Router" as const,
    routePath: routePath || pathname,
    routeType: "render" as const,
  };
  return createRscOnErrorHandler({
    errorContext,
    reportRequestError,
    requestInfo,
  });
}
