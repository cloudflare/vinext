import {
  canonicalizeLoadingShellRscRequestHeaders,
  canonicalizePrewarmableRscRequestHeaders,
  createCanonicalRscRequestUrl,
  createRscRequestUrl,
} from "../../server/app-rsc-cache-busting.js";

export type ResolveAppPrefetchRscRequestOptions = {
  canUseCanonicalLoadingShell: boolean;
  fullHref: string;
  headers: Headers;
  interceptionContext: string | null;
  mountedSlotsHeader: string | null;
  prefetchInlining: boolean;
  requiresRouteTreePrefetch: boolean;
  rewrittenPrefetchHref: string | null;
};

export type ResolvedAppPrefetchRscRequest = {
  additionalRscUrls: string[];
  rscUrl: string;
  usesCanonicalPrewarmedRequest: boolean;
};

/**
 * Resolve the RSC request identity shared by `<Link>` and `router.prefetch()`.
 * Only full routes and ordinary loading shells without request-specific
 * context can reuse deploy-prewarmed CDN entries. Contextual requests retain
 * their varying headers and deterministic `_rsc` digest.
 */
export async function resolveAppPrefetchRscRequest({
  canUseCanonicalLoadingShell,
  fullHref,
  headers,
  interceptionContext,
  mountedSlotsHeader,
  prefetchInlining,
  requiresRouteTreePrefetch,
  rewrittenPrefetchHref,
}: ResolveAppPrefetchRscRequestOptions): Promise<ResolvedAppPrefetchRscRequest> {
  const canUseCanonicalSharedRequest =
    process.env.__NEXT_CONFIG_OUTPUT !== "export" &&
    process.env.__VINEXT_CANONICAL_RSC_REQUESTS === "1" &&
    interceptionContext === null &&
    mountedSlotsHeader === null &&
    (rewrittenPrefetchHref === null || rewrittenPrefetchHref === fullHref) &&
    !requiresRouteTreePrefetch &&
    !prefetchInlining;
  const usesCanonicalLoadingShell =
    canUseCanonicalSharedRequest &&
    canUseCanonicalLoadingShell &&
    canonicalizeLoadingShellRscRequestHeaders(headers);
  const usesCanonicalFullRoute =
    canUseCanonicalSharedRequest &&
    !usesCanonicalLoadingShell &&
    canonicalizePrewarmableRscRequestHeaders(headers);

  // Both derive from the same headers and neither feeds the other, so the
  // rewrite variant is generated alongside rather than after.
  const [rscUrl, ...additionalRscUrls] = await Promise.all([
    usesCanonicalFullRoute
      ? createCanonicalRscRequestUrl(fullHref)
      : createRscRequestUrl(fullHref, headers),
    ...(rewrittenPrefetchHref !== null && rewrittenPrefetchHref !== fullHref
      ? [createRscRequestUrl(rewrittenPrefetchHref, headers)]
      : []),
  ]);

  return {
    additionalRscUrls,
    rscUrl,
    usesCanonicalPrewarmedRequest: usesCanonicalLoadingShell || usesCanonicalFullRoute,
  };
}
