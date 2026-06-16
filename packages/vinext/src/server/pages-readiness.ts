import type { VinextNextData } from "../client/vinext-next-data.js";
import type { PagesPageModule } from "./pages-page-data.js";

/**
 * Shared Pages Router readiness modeling.
 *
 * The initial `router.isReady` value for the `next/navigation` compat hooks is
 * derived from the page/_app data-fetching exports plus the configured-rewrites
 * flag, serialized into `__NEXT_DATA__`. The dev SSR handler and the production
 * Pages page handler must compute this identically so server HTML and client
 * hydration agree — see `getPagesNavigationIsReadyFromSerializedState` in
 * `shims/router.ts`.
 */

/**
 * The serialized readiness flags (gssp/gsp/gip/appGip/autoExport +
 * `__vinext.hasRewrites`) that gate the initial Pages Router `router.isReady`.
 * The field names/types are projected from the canonical `VinextNextData` so
 * this stays in lockstep with the `__NEXT_DATA__` shape it feeds into.
 */
type PagesReadinessNextData = Pick<
  VinextNextData,
  "gssp" | "gsp" | "gip" | "appGip" | "autoExport" | "nextExport"
> & {
  __vinext: Pick<NonNullable<VinextNextData["__vinext"]>, "hasRewrites">;
};

/**
 * Build the readiness flags for a Pages Router render. Shared by the dev and
 * production Pages render paths.
 */
export function buildPagesReadinessNextData(options: {
  pageModule: PagesPageModule;
  appComponent: { getInitialProps?: unknown; origGetInitialProps?: unknown } | null | undefined;
  hasRewrites: boolean;
}): PagesReadinessNextData {
  const hasPageGssp = typeof options.pageModule.getServerSideProps === "function";
  const hasPageGsp = typeof options.pageModule.getStaticProps === "function";
  const hasPageGip =
    typeof (options.pageModule.default as { getInitialProps?: unknown } | undefined)
      ?.getInitialProps === "function";
  const hasAppGip =
    typeof options.appComponent?.getInitialProps === "function" &&
    options.appComponent.getInitialProps !== options.appComponent.origGetInitialProps;
  const autoExport = !hasPageGssp && !hasPageGsp && !hasPageGip && !hasAppGip;
  return {
    gssp: hasPageGssp,
    gsp: hasPageGsp ? true : undefined,
    gip: hasPageGip,
    appGip: hasAppGip,
    autoExport,
    nextExport: autoExport ? true : undefined,
    __vinext: { hasRewrites: options.hasRewrites },
  };
}

/**
 * Compute the `__NEXT_DATA__.query` value for a Pages Router SSR render so the
 * inlined value is identical to what the client router writes after a soft
 * navigation (see `shims/router.ts`'s `mergeRouteParamsIntoQuery` call). Shared
 * by the prod (`buildPagesNextDataScript`) and dev SSR render paths so they
 * cannot drift.
 *
 *   - getServerSideProps / page or _app `getInitialProps` → full merged query
 *     (URL querystring + route params). This is the #1970 fix: a per-request
 *     server render's `__NEXT_DATA__.query` must carry the querystring, matching
 *     Next.js and the client router after a soft nav.
 *   - getStaticProps → route params only; the querystring is dropped (a static
 *     page's output can't depend on the request query — Next.js parity).
 *   - autoExport / getStaticPaths fallback shell → route params only.
 *
 * Every non-gSSP/gIP case keeps the route params (rather than resetting to `{}`
 * for autoExport/fallback as Next.js does) because vinext's client recovers a
 * dynamic route's params from `__NEXT_DATA__.query` whenever the visible URL
 * path doesn't match the route pattern — e.g. a rewrite from
 * `/rewrite-navigation/0` to `/rewrite-navigation/[id]/destination`, where the
 * params live nowhere else on the page (`getRouteQueryFromNextData` in
 * `shims/router.ts`). Emptying the query there would drop `useRouter().query`'s
 * route params on hydration.
 *
 * `query` is the already-merged query (querystring + route params); `params` is
 * the route-match params only.
 */
export function computePagesNextDataQuery(opts: {
  query: Record<string, unknown>;
  params: Record<string, unknown>;
  isFallback: boolean;
  autoExport: boolean | undefined;
  gsp: boolean | undefined;
}): Record<string, unknown> {
  if (opts.isFallback || opts.autoExport || opts.gsp) return opts.params;
  return opts.query;
}
