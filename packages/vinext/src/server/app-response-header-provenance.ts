import { preserveFullyBufferedBodyMetadata } from "vinext/shims/unified-request-context";

const frameworkLinkHeaders = new WeakSet<Headers>();
const edgeRouteHandlerLinkHeaders = new WeakSet<Headers>();

const APP_RESPONSE_STAGE_LINK_PROVENANCE_HEADER = "x-vinext-app-stage-post-config-link";

/** Mark response headers whose Link value was emitted by the App page renderer. */
export function markFrameworkLinkHeaders(
  headers: Headers,
  linkHeader: string | string[] | null | undefined,
): void {
  if (linkHeader && (typeof linkHeader === "string" || linkHeader.length > 0)) {
    frameworkLinkHeaders.add(headers);
  }
}

/** Whether the response carries renderer-owned Link values that config may prepend to. */
export function hasFrameworkLinkHeaders(headers: Headers): boolean {
  return frameworkLinkHeaders.has(headers);
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

/** Preserve Link provenance when a response wrapper reconstructs a Response. */
export function copyLinkHeaderProvenance(source: Headers, target: Headers): void {
  if (frameworkLinkHeaders.has(source)) frameworkLinkHeaders.add(target);
  if (edgeRouteHandlerLinkHeaders.has(source)) edgeRouteHandlerLinkHeaders.add(target);
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
