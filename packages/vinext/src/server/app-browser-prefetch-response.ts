import { stripRscCacheBustingSearchParam } from "./app-rsc-cache-busting.js";

function normalizeBrowserRscUrlForReuse(
  url: string | null | undefined,
  origin: string,
): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url, origin);
    stripRscCacheBustingSearchParam(parsed);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

function canonicalizeBrowserRscResponseUrl(responseUrl: string, origin: string): string {
  try {
    const parsed = new URL(responseUrl, origin);
    if (parsed.origin === new URL(origin).origin) {
      return `${parsed.pathname}${parsed.search}`;
    }
  } catch {
    // Preserve the original value so the normal navigation response
    // validation can decide whether it requires a hard navigation.
  }
  return responseUrl;
}

export function resolvePrefetchNavigationResponseUrl(options: {
  additionalRscUrls: readonly string[];
  origin: string;
  responseUrl: string;
  visibleRscUrl: string;
}): string {
  const normalizedResponseUrl = normalizeBrowserRscUrlForReuse(options.responseUrl, options.origin);
  const matchedAlternate =
    normalizedResponseUrl !== null &&
    options.additionalRscUrls.some(
      (additionalRscUrl) =>
        normalizeBrowserRscUrlForReuse(additionalRscUrl, options.origin) === normalizedResponseUrl,
    );
  return matchedAlternate
    ? options.visibleRscUrl
    : canonicalizeBrowserRscResponseUrl(options.responseUrl, options.origin);
}
