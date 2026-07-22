/** Detect an absolute URL with any scheme, or a protocol-relative URL. */
export function isExternalUrl(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//");
}
