import { createRscOnErrorHandler } from "./app-rsc-errors.js";
import { RSC_HEADER } from "./app-rsc-vary.js";
import {
  isOnDemandRevalidateRequest,
  PRERENDER_REVALIDATE_HEADER,
} from "./revalidation-request.js";

type ReportRequestError = (
  error: unknown,
  requestInfo: { path: string; method: string; headers: Record<string, string> },
  errorContext: {
    routerKind: "App Router";
    routePath: string;
    routeType: "render" | "action";
    renderSource?:
      | "react-server-components"
      | "react-server-components-payload"
      | "server-rendering";
    revalidateReason: "on-demand" | "stale" | undefined;
  },
) => void | Promise<void>;

export type AppRenderErrorContextOverrides = {
  renderSource?: "react-server-components" | "react-server-components-payload" | "server-rendering";
  revalidateReason?: "on-demand" | "stale";
  routeType?: "render" | "action";
};

// The errors each request's handlers already logged.
const loggedErrorsByRequest = new WeakMap<Request, WeakSet<object>>();

/**
 * Build a per-request RSC error handler that extracts request metadata from
 * the incoming Web `Request`, wires it into a `createRscOnErrorHandler` call,
 * and binds the configured `reportRequestError` reporter.
 *
 * Takes all deps explicitly. The only module-level state is the set of errors
 * each request already logged, keyed weakly by its `Request`.
 */
export function createAppRscOnErrorHandler(
  reportRequestError: ReportRequestError,
  request: Request,
  pathname: string,
  routePath: string,
  overrides?: AppRenderErrorContextOverrides,
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
    routeType: overrides?.routeType ?? ("render" as const),
    renderSource:
      overrides?.renderSource ??
      (request.headers.get(RSC_HEADER) === "1" || new URL(request.url).pathname.endsWith(".rsc")
        ? ("react-server-components-payload" as const)
        : ("react-server-components" as const)),
    revalidateReason: isOnDemandRevalidateRequest(request.headers.get(PRERENDER_REVALIDATE_HEADER))
      ? ("on-demand" as const)
      : overrides?.revalidateReason,
  };
  let loggedErrors = loggedErrorsByRequest.get(request);
  if (!loggedErrors) {
    loggedErrors = new WeakSet();
    loggedErrorsByRequest.set(request, loggedErrors);
  }
  return createRscOnErrorHandler({
    attachDigest: errorContext.renderSource !== "server-rendering",
    errorContext,
    loggedErrors,
    reportRequestError(error, info, context) {
      void reportRequestError(error, info, context);
    },
    requestInfo,
  });
}
