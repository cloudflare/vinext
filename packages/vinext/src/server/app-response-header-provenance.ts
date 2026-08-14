const frameworkLinkHeaders = new WeakSet<Headers>();
const edgeRouteHandlerLinkHeaders = new WeakSet<Headers>();

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
