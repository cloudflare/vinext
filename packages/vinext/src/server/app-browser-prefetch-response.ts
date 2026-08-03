import { stripRscCacheBustingSearchParam } from "./app-rsc-cache-busting.js";
import { peekPrefetchResponseForNavigation, type CachedRscResponse } from "vinext/shims/navigation";

export function peekSettledPrefetchResponseForNavigation(options: {
  additionalRscUrls: readonly string[];
  bypassNavigationCache: boolean;
  interceptionContext: string | null;
  mountedSlotsHeader: string | null;
  navigationKind: "navigate" | "refresh" | "traverse";
  peek?: typeof peekPrefetchResponseForNavigation;
  targetPathAndSearch: string;
}): CachedRscResponse | null {
  if (options.navigationKind !== "navigate" || options.bypassNavigationCache) {
    return null;
  }
  return (options.peek ?? peekPrefetchResponseForNavigation)(
    options.targetPathAndSearch,
    options.interceptionContext,
    options.mountedSlotsHeader,
    { additionalRscUrls: options.additionalRscUrls },
  );
}

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

function isSameOriginBrowserRscUrl(url: string, origin: string): boolean {
  try {
    return new URL(url, origin).origin === new URL(origin).origin;
  } catch {
    return false;
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
    isSameOriginBrowserRscUrl(options.responseUrl, options.origin) &&
    options.additionalRscUrls.some(
      (additionalRscUrl) =>
        normalizeBrowserRscUrlForReuse(additionalRscUrl, options.origin) === normalizedResponseUrl,
    );
  return matchedAlternate
    ? options.visibleRscUrl
    : canonicalizeBrowserRscResponseUrl(options.responseUrl, options.origin);
}

export function prepareConsumedPrefetchResponseForPublication(
  response: CachedRscResponse,
  responseUrl: string,
): {
  expiresAt: number | undefined;
  preparedElements: CachedRscResponse["preparedElements"];
  snapshot: CachedRscResponse;
} {
  const { expiresAt, preparedElements, ...snapshot } = response;
  return {
    expiresAt,
    preparedElements,
    snapshot: { ...snapshot, url: responseUrl },
  };
}

export function preserveCommittedPrefetchExpiry(
  snapshot: CachedRscResponse,
  expiresAt: number | undefined,
): CachedRscResponse {
  return expiresAt === undefined ? snapshot : { ...snapshot, expiresAt };
}
