const frameworkLinkHeaders = new WeakSet<Headers>();

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
