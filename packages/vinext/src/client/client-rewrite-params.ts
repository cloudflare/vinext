/**
 * Whether a rewrite to `destination` appends the source `params` to its
 * query. Next.js does that when the destination's path, host and hash use
 * none of them, for each param its query does not already name; the Pages
 * router's sync rewrite path does not, so it defers these rewrites.
 */
export function clientRewriteAppendsParams(
  destination: string,
  params: Record<string, string>,
): boolean {
  // Like the server, the i18n locale param never triggers the append.
  const keys = Object.keys(params).filter((key) => key !== "nextInternalLocale");
  if (keys.length === 0) return false;
  const hashIndex = destination.indexOf("#");
  const beforeHash = hashIndex === -1 ? destination : destination.slice(0, hashIndex);
  const queryIndex = beforeHash.indexOf("?");
  const withoutQuery =
    (queryIndex === -1 ? beforeHash : beforeHash.slice(0, queryIndex)) +
    (hashIndex === -1 ? "" : destination.slice(hashIndex));
  // Source param names are `\w+`, so they need no escaping.
  if (keys.some((key) => new RegExp(`:${key}(?![A-Za-z0-9_])`).test(withoutQuery))) return false;
  const queryKeys = new Set(
    queryIndex === -1 ? [] : new URLSearchParams(beforeHash.slice(queryIndex + 1)).keys(),
  );
  return keys.some((key) => !queryKeys.has(key));
}
