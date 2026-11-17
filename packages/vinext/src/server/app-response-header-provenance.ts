import { preserveFullyBufferedBodyMetadata } from "vinext/shims/unified-request-context";

// The Link value the App page renderer emitted on each marked response.
const frameworkLinkHeaders = new WeakMap<Headers, string>();
const edgeRouteHandlerLinkHeaders = new WeakSet<Headers>();
// Headers whose Cache-Control is the browser-only form of a Route Handler's own
// policy, on a response that bypasses shared caches.
const routeHandlerCachePolicyHeaders = new WeakSet<Headers>();

const APP_RESPONSE_STAGE_LINK_PROVENANCE_HEADER = "x-vinext-app-stage-post-config-link";
const APP_RESPONSE_STAGE_ROUTE_HANDLER_CACHE_POLICY_HEADER =
  "x-vinext-app-stage-route-handler-cache-policy";

/** Mark response headers whose Link value was emitted by the App page renderer. */
export function markFrameworkLinkHeaders(
  headers: Headers,
  linkHeader: string | string[] | null | undefined,
): void {
  const value = Array.isArray(linkHeader) ? linkHeader.join(", ") : linkHeader;
  if (value) frameworkLinkHeaders.set(headers, value);
}

/** Whether the response carries renderer-owned Link values that config may prepend to. */
export function hasFrameworkLinkHeaders(headers: Headers): boolean {
  return frameworkLinkHeaders.has(headers);
}

/** The renderer-owned part of the response's Link header, without middleware's. */
export function getFrameworkLinkHeader(headers: Headers): string | null {
  return frameworkLinkHeaders.get(headers) ?? null;
}

/** Mark Link values returned by an Edge route handler after config and middleware. */
export function markEdgeRouteHandlerLinkHeaders(
  headers: Headers,
  linkHeader: string | null | undefined,
): void {
  if (linkHeader) {
    edgeRouteHandlerLinkHeaders.add(headers);
  }
}

/** Whether config must precede a later framework or Edge-handler Link value. */
export function hasPostConfigLinkHeaders(headers: Headers): boolean {
  return frameworkLinkHeaders.has(headers) || edgeRouteHandlerLinkHeaders.has(headers);
}

/**
 * Mark response headers whose Cache-Control is the browser-only form of the
 * Route Handler's policy, on a response kept out of shared caches.
 */
export function markRouteHandlerCachePolicyHeaders(headers: Headers): void {
  routeHandlerCachePolicyHeaders.add(headers);
}

/** Whether a never-cache response policy must keep the response's browser-only Route Handler policy. */
export function hasRouteHandlerCachePolicyHeaders(headers: Headers): boolean {
  return routeHandlerCachePolicyHeaders.has(headers);
}

/** Preserve Link and Route Handler Cache-Control provenance when a wrapper reconstructs a Response. */
export function copyLinkHeaderProvenance(source: Headers, target: Headers): void {
  const frameworkLink = frameworkLinkHeaders.get(source);
  if (frameworkLink !== undefined) frameworkLinkHeaders.set(target, frameworkLink);
  if (edgeRouteHandlerLinkHeaders.has(source)) edgeRouteHandlerLinkHeaders.add(target);
  if (routeHandlerCachePolicyHeaders.has(source)) routeHandlerCachePolicyHeaders.add(target);
}

/**
 * Serialize Route Handler Cache-Control provenance across a response-stage
 * transport. An application value under the marker name is removed.
 */
export function serializeResponseStageRouteHandlerCachePolicy(response: Response): Response {
  const marked = routeHandlerCachePolicyHeaders.has(response.headers);
  if (!marked && !response.headers.has(APP_RESPONSE_STAGE_ROUTE_HANDLER_CACHE_POLICY_HEADER)) {
    return response;
  }
  const headers = new Headers(response.headers);
  if (marked) headers.set(APP_RESPONSE_STAGE_ROUTE_HANDLER_CACHE_POLICY_HEADER, "1");
  else headers.delete(APP_RESPONSE_STAGE_ROUTE_HANDLER_CACHE_POLICY_HEADER);
  const serialized = preserveFullyBufferedBodyMetadata(
    response,
    new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    }),
  );
  copyLinkHeaderProvenance(response.headers, serialized.headers);
  return serialized;
}

/**
 * Consume Route Handler Cache-Control provenance from a response-stage result:
 * the transport marker of a remote stage, or the mark of a local one.
 */
export function consumeResponseStageRouteHandlerCachePolicy(response: Response): {
  keepsRouteHandlerCachePolicy: boolean;
  response: Response;
} {
  if (!response.headers.has(APP_RESPONSE_STAGE_ROUTE_HANDLER_CACHE_POLICY_HEADER)) {
    return {
      keepsRouteHandlerCachePolicy: routeHandlerCachePolicyHeaders.has(response.headers),
      response,
    };
  }
  const keepsRouteHandlerCachePolicy =
    response.headers.get(APP_RESPONSE_STAGE_ROUTE_HANDLER_CACHE_POLICY_HEADER) === "1";
  const headers = new Headers(response.headers);
  headers.delete(APP_RESPONSE_STAGE_ROUTE_HANDLER_CACHE_POLICY_HEADER);
  const consumed = preserveFullyBufferedBodyMetadata(
    response,
    new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    }),
  );
  copyLinkHeaderProvenance(response.headers, consumed.headers);
  return { keepsRouteHandlerCachePolicy, response: consumed };
}

/** Serialize otherwise process-local Link provenance across a response-stage transport. */
export function serializeResponseStageLinkProvenance(response: Response): Response {
  if (!hasPostConfigLinkHeaders(response.headers)) return response;
  const headers = new Headers(response.headers);
  headers.set(APP_RESPONSE_STAGE_LINK_PROVENANCE_HEADER, "1");
  return preserveFullyBufferedBodyMetadata(
    response,
    new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    }),
  );
}

/** Consume transported Link provenance before applying outer config and middleware. */
export function consumeResponseStageLinkProvenance(response: Response): {
  appendToPostConfigLink: boolean;
  response: Response;
} {
  if (response.headers.get(APP_RESPONSE_STAGE_LINK_PROVENANCE_HEADER) !== "1") {
    return { appendToPostConfigLink: false, response };
  }

  const headers = new Headers(response.headers);
  headers.delete(APP_RESPONSE_STAGE_LINK_PROVENANCE_HEADER);
  const transported = preserveFullyBufferedBodyMetadata(
    response,
    new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    }),
  );
  markFrameworkLinkHeaders(transported.headers, transported.headers.get("link"));
  return {
    appendToPostConfigLink: true,
    response: transported,
  };
}
