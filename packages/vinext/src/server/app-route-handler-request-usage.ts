import type { RouteHandlerHttpMethod } from "./app-route-handler-runtime.js";

/**
 * Reserved export injected into App Route modules by the vinext transform.
 *
 * The value is deliberately validated fail-closed at runtime: only an exact
 * `false` lets an auto-mode handler use ISR before it has executed.
 */
export const APP_ROUTE_REQUEST_USAGE_EXPORT =
  "__vinext_internal_route_request_usage_DO_NOT_USE" as const;

export type AppRouteRequestUsageMetadata = Partial<Record<RouteHandlerHttpMethod, boolean>>;

export function appRouteHandlerRequestMayBeUsed(
  routeModule: Record<string, unknown>,
  method: RouteHandlerHttpMethod,
): boolean {
  const metadata = routeModule[APP_ROUTE_REQUEST_USAGE_EXPORT];
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return true;
  return (metadata as Record<string, unknown>)[method] !== false;
}
