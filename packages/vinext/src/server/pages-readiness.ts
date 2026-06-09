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

/** Page or `_app` module shape carrying optional data-fetching exports. */
type PagesDataFetchingModule = {
  getServerSideProps?: unknown;
  getStaticProps?: unknown;
  default?: unknown;
};

export type PagesReadinessNextData = {
  gssp: boolean;
  gsp: boolean;
  gip: boolean;
  appGip: boolean;
  autoExport: boolean;
  __vinext: { hasRewrites: boolean };
};

/**
 * Build the serialized `__NEXT_DATA__` readiness flags
 * (gssp/gsp/gip/appGip/autoExport + `__vinext.hasRewrites`) that gate the
 * initial Pages Router `router.isReady` value for the `next/navigation` compat
 * hooks. Shared by the dev and production Pages render paths.
 */
export function buildPagesReadinessNextData(options: {
  pageModule: PagesDataFetchingModule;
  appComponent: { getInitialProps?: unknown } | null | undefined;
  hasRewrites: boolean;
}): PagesReadinessNextData {
  const hasPageGssp = typeof options.pageModule.getServerSideProps === "function";
  const hasPageGsp = typeof options.pageModule.getStaticProps === "function";
  const hasPageGip =
    typeof (options.pageModule.default as { getInitialProps?: unknown } | undefined)
      ?.getInitialProps === "function";
  const hasAppGip = typeof options.appComponent?.getInitialProps === "function";
  return {
    gssp: hasPageGssp,
    gsp: hasPageGsp,
    gip: hasPageGip,
    appGip: hasAppGip,
    autoExport: !hasPageGssp && !hasPageGsp && !hasPageGip && !hasAppGip,
    __vinext: { hasRewrites: options.hasRewrites },
  };
}
