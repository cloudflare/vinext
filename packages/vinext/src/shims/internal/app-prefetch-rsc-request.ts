import { createRscRequestUrl } from "../../server/app-rsc-cache-busting.js";

export type ResolveAppPrefetchRscRequestOptions = {
  fullHref: string;
  headers: Headers;
  rewrittenPrefetchHref: string | null;
};

export type ResolvedAppPrefetchRscRequest = {
  additionalRscUrls: string[];
  rscUrl: string;
};

/** Resolve the ordinary RSC request identities shared by `<Link>` and `router.prefetch()`. */
export async function resolveAppPrefetchRscRequest({
  fullHref,
  headers,
  rewrittenPrefetchHref,
}: ResolveAppPrefetchRscRequestOptions): Promise<ResolvedAppPrefetchRscRequest> {
  const [rscUrl, ...additionalRscUrls] = await Promise.all([
    createRscRequestUrl(fullHref, headers),
    ...(rewrittenPrefetchHref !== null && rewrittenPrefetchHref !== fullHref
      ? [createRscRequestUrl(rewrittenPrefetchHref, headers)]
      : []),
  ]);

  return { additionalRscUrls, rscUrl };
}
