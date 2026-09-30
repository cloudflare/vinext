/**
 * Every vinext runtime module that a production client build emits behind a
 * dynamic import, with the recovery path that covers a failed load of it.
 * `tests/app-router-production-build.test.ts` fails when a lazy runtime chunk
 * has no entry here, so a new lazy import cannot ship without a named recovery.
 *
 * `module` is the path below `packages/vinext/src` (or `dist`), without the
 * file extension.
 */
export type LazyRuntimeChunkRecovery = {
  module: string;
  recovery: string;
};

const APP_PREFETCH_RECOVERY =
  "App prefetch path: Link logs the failure and never navigates for it; a click loads through the AR-4 navigation loader, which falls back to a document navigation";
const CLIENT_REFERENCE_RECOVERY =
  "AR-2 client-reference loader: a hydration failure recovers at once, a later failure recovers through the root error callbacks";
const PAGES_NAVIGATION_RECOVERY =
  "Pages navigation: a failed import ends in a document navigation to the requested URL";

export const LAZY_RUNTIME_CHUNK_RECOVERY: readonly LazyRuntimeChunkRecovery[] = [
  { module: "client/client-rewrite-matcher", recovery: PAGES_NAVIGATION_RECOVERY },
  { module: "config/config-matchers", recovery: PAGES_NAVIGATION_RECOVERY },
  { module: "server/app-elements", recovery: APP_PREFETCH_RECOVERY },
  { module: "server/app-rsc-cache-busting", recovery: APP_PREFETCH_RECOVERY },
  { module: "server/app-rsc-render-mode", recovery: APP_PREFETCH_RECOVERY },
  { module: "server/headers", recovery: APP_PREFETCH_RECOVERY },
  { module: "shims/dynamic", recovery: CLIENT_REFERENCE_RECOVERY },
  { module: "shims/dynamic-preload-chunks", recovery: CLIENT_REFERENCE_RECOVERY },
  { module: "shims/error", recovery: PAGES_NAVIGATION_RECOVERY },
  { module: "shims/form", recovery: CLIENT_REFERENCE_RECOVERY },
  {
    module: "shims/image",
    recovery: CLIENT_REFERENCE_RECOVERY,
  },
  {
    module: "shims/internal/app-prefetch-rsc-request",
    recovery: APP_PREFETCH_RECOVERY,
  },
  {
    module: "shims/internal/app-route-prefetch-policy",
    recovery: APP_PREFETCH_RECOVERY,
  },
  {
    module: "shims/internal/hybrid-client-route-owner",
    recovery:
      "AR-3 shared loader: a failed load resolves to null and every caller navigates by document",
  },
  { module: "shims/layout-segment-context", recovery: CLIENT_REFERENCE_RECOVERY },
  { module: "shims/link", recovery: CLIENT_REFERENCE_RECOVERY },
  {
    module: "shims/navigation",
    recovery:
      "AR-4 navigation loader: a click falls back to a document navigation, a prefetch logs the failure and never navigates",
  },
  {
    module: "shims/router",
    recovery:
      "Pages navigation: Link and next/form load it through a path that falls back to a document navigation",
  },
  { module: "shims/script", recovery: CLIENT_REFERENCE_RECOVERY },
];
