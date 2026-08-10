/**
 * Compatibility scope for Next.js deploy-suite files.
 *
 * This is intentionally file-level: historical compatibility rows only retain
 * per-file counts. Keeping the policy here lets every historical run be
 * reclassified at read time without rewriting D1 data. Suites absent from this
 * map are supported by default so newly-added Next.js tests remain visible.
 */

export type SuiteSupportStatus = "supported" | "deferred" | "needs-vite-equivalent" | "unsupported";

export type SuiteSupport = {
  status: SuiteSupportStatus;
  feature: string | null;
  reason: string | null;
};

type ScopedSuiteSupport = SuiteSupport & {
  status: Exclude<SuiteSupportStatus, "supported">;
};

const DEFERRED_CACHE_COMPONENTS = {
  status: "deferred",
  feature: "Cache Components and use cache",
  reason: "Cache Components are not implemented yet.",
} as const satisfies ScopedSuiteSupport;

const DEFERRED_PARTIAL_PRERENDERING = {
  status: "deferred",
  feature: "Partial prerendering and fallback shells",
  reason: "Depends on Cache Components and partial prerendering support.",
} as const satisfies ScopedSuiteSupport;

const DEFERRED_SEGMENT_CACHE = {
  status: "deferred",
  feature: "Segment cache and Cache Components prefetching",
  reason: "Depends on the Cache Components segment-cache protocol.",
} as const satisfies ScopedSuiteSupport;

const NEXT_BUNDLER_SPECIFIC = {
  status: "unsupported",
  feature: "Webpack, Turbopack, or Babel customization",
  reason: "Exercises a Next.js compiler surface rather than Vite or Rolldown behavior.",
} as const satisfies ScopedSuiteSupport;

const VITE_RUNTIME_CONDITIONS = {
  status: "needs-vite-equivalent",
  feature: "React and runtime export conditions",
  reason:
    "The capability needs Vite, RSC, and Workers coverage; exact edge-light assertions are Next.js-specific.",
} as const satisfies ScopedSuiteSupport;

export const SUITE_SUPPORT_POLICY = {
  "test/e2e/app-dir/app-root-params-getters/use-cache.test.ts": DEFERRED_CACHE_COMPONENTS,
  "test/e2e/app-dir/cache-components-allow-otel-spans/cache-components-allow-otel-spans.test.ts":
    DEFERRED_CACHE_COMPONENTS,
  "test/e2e/app-dir/cache-components/cache-components.server-action.test.ts":
    DEFERRED_CACHE_COMPONENTS,
  "test/e2e/app-dir/concurrent-navigations/mismatching-prefetch.test.ts":
    DEFERRED_PARTIAL_PRERENDERING,
  "test/e2e/app-dir/fallback-shells/fallback-shells.test.ts": DEFERRED_PARTIAL_PRERENDERING,
  "test/e2e/app-dir/next-config/index.test.ts": NEXT_BUNDLER_SPECIFIC,
  "test/e2e/app-dir/prefetch-true-instant/prefetch-true-instant.test.ts":
    DEFERRED_PARTIAL_PRERENDERING,
  "test/e2e/app-dir/resume-data-cache/resume-data-cache.test.ts": DEFERRED_PARTIAL_PRERENDERING,
  "test/e2e/app-dir/rsc-basic/rsc-basic-react-experimental.test.ts": {
    status: "unsupported",
    feature: "Next.js experimental React channel selection",
    reason:
      "Vinext should support portable React APIs rather than Next.js package-channel selection.",
  },
  "test/e2e/app-dir/scss/npm-import-tilde/npm-import-tilde.test.ts": NEXT_BUNDLER_SPECIFIC,
  "test/e2e/app-dir/segment-cache/basic/segment-cache-basic.test.ts": DEFERRED_SEGMENT_CACHE,
  "test/e2e/app-dir/segment-cache/cached-navigations/cached-navigations.test.ts":
    DEFERRED_SEGMENT_CACHE,
  "test/e2e/app-dir/segment-cache/dynamic-on-hover/dynamic-on-hover.test.ts":
    DEFERRED_SEGMENT_CACHE,
  "test/e2e/app-dir/segment-cache/encoded-slash-params/encoded-slash-params.test.ts":
    DEFERRED_SEGMENT_CACHE,
  "test/e2e/app-dir/segment-cache/force-stale/force-stale.test.ts": DEFERRED_SEGMENT_CACHE,
  "test/e2e/app-dir/segment-cache/prefetch-inlining/prefetch-inlining.test.ts":
    DEFERRED_SEGMENT_CACHE,
  "test/e2e/app-dir/segment-cache/prefetch-layout-sharing/prefetch-layout-sharing.test.ts":
    DEFERRED_SEGMENT_CACHE,
  "test/e2e/app-dir/segment-cache/prefetch-scheduling/prefetch-scheduling.test.ts":
    DEFERRED_SEGMENT_CACHE,
  "test/e2e/app-dir/segment-cache/refresh/segment-cache-refresh.test.ts": DEFERRED_SEGMENT_CACHE,
  "test/e2e/app-dir/segment-cache/search-params/segment-cache-search-params-shared-loading-state.test.ts":
    DEFERRED_SEGMENT_CACHE,
  "test/e2e/app-dir/segment-cache/search-params/segment-cache-search-params.test.ts":
    DEFERRED_SEGMENT_CACHE,
  "test/e2e/app-dir/segment-cache/staleness/segment-cache-per-page-dynamic-stale-time.test.ts":
    DEFERRED_SEGMENT_CACHE,
  "test/e2e/app-dir/segment-cache/staleness/segment-cache-stale-time.test.ts":
    DEFERRED_SEGMENT_CACHE,
  "test/e2e/app-dir/segment-cache/vary-params-base-dynamic/vary-params-base-dynamic.test.ts":
    DEFERRED_SEGMENT_CACHE,
  "test/e2e/app-dir/segment-cache/vary-params/root-params-segment-prefetch.test.ts":
    DEFERRED_SEGMENT_CACHE,
  "test/e2e/app-dir/segment-cache/vary-params/vary-params.test.ts": DEFERRED_SEGMENT_CACHE,
  "test/e2e/app-dir/use-cache-metadata-route-handler/use-cache-metadata-route-handler.test.ts":
    DEFERRED_CACHE_COMPONENTS,
  "test/e2e/app-dir/use-cache-with-server-function-props/use-cache-with-server-function-props.test.ts":
    DEFERRED_CACHE_COMPONENTS,
  "test/e2e/app-dir/webpack-loader-set-environment-variable/webpack-loader-set-environment-variable.test.ts":
    NEXT_BUNDLER_SPECIFIC,
  "test/e2e/app-dir/worker/worker.test.ts": {
    status: "needs-vite-equivalent",
    feature: "Browser Web Workers and emitted worker assets",
    reason:
      "Web Worker behavior needs Vite and Rolldown coverage; Next.js deployment-token assertions are not portable.",
  },
  "test/e2e/babel/index.test.ts": NEXT_BUNDLER_SPECIFIC,
  "test/e2e/import-conditions/import-conditions.test.ts": VITE_RUNTIME_CONDITIONS,
  "test/e2e/react-version/react-version.test.ts": VITE_RUNTIME_CONDITIONS,
} as const satisfies Record<string, ScopedSuiteSupport>;

/** Feature labels for the supported failures classified in run 29551314872. */
const SUPPORTED_SUITE_FEATURES = {
  "test/e2e/app-dir/app-client-cache/client-cache.parallel-routes.test.ts":
    "App Router prefetch and client cache",
  "test/e2e/app-dir/app-prefetch-false-loading/app-prefetch-false-loading.test.ts":
    "App Router loading UI, Suspense, and streaming",
  "test/e2e/app-dir/app-prefetch-false/app-prefetch-false.test.ts":
    "App Router prefetch and client cache",
  "test/e2e/app-dir/app-prefetch/prefetching.test.ts": "App Router prefetch and client cache",
  "test/e2e/app-dir/app-static/app-static.test.ts":
    "App Router streaming, static rendering, and revalidation",
  "test/e2e/app-dir/app/index.test.ts": "App Router navigation, streaming, and routing",
  "test/e2e/app-dir/client-module-with-package-type/index.test.ts":
    "Module formats, externals, and package resolution",
  "test/e2e/app-dir/metadata-icons/metadata-icons.test.ts": "Metadata rendering and navigation",
  "test/e2e/app-dir/metadata-navigation/metadata-navigation.test.ts":
    "Metadata rendering and navigation",
  "test/e2e/app-dir/metadata-streaming/metadata-streaming.test.ts":
    "Metadata rendering and navigation",
  "test/e2e/app-dir/navigation/navigation.test.ts": "App Router navigation and metadata",
  "test/e2e/app-dir/next-after-app-deploy/index.test.ts": "ISR, tags, revalidation, and after()",
  "test/e2e/app-dir/next-config-ts-native-mts/dynamic-import-esm/next-config-ts-dynamic-import-esm.test.ts":
    "next.config and custom tsconfig loading",
  "test/e2e/app-dir/next-config-ts-native-ts/dynamic-import-esm/next-config-ts-dynamic-import-esm.test.ts":
    "next.config and custom tsconfig loading",
  "test/e2e/app-dir/next-dynamic-css/next-dynamic-css.test.ts":
    "CSS ordering, styled-jsx, and dynamic CSS",
  "test/e2e/app-dir/parallel-routes-and-interception-from-root/parallel-routes-and-interception-from-root.test.ts":
    "Parallel routes, interception, dynamic params, and RSC routing",
  "test/e2e/app-dir/parallel-routes-revalidation/parallel-routes-revalidation.test.ts":
    "Parallel routes, interception, dynamic params, and RSC routing",
  "test/e2e/app-dir/parallel-routes-root-param-dynamic-child/parallel-routes-root-param-dynamic-child.test.ts":
    "Parallel routes, interception, dynamic params, and RSC routing",
  "test/e2e/app-dir/rsc-query-routing/rsc-query-routing.test.ts":
    "Parallel routes, interception, dynamic params, and RSC routing",
  "test/e2e/app-dir/shallow-routing/shallow-routing.test.ts":
    "App Router navigation, Link, and history",
  "test/e2e/app-document/rendering.test.ts": "Pages Router rendering and data APIs",
  "test/e2e/basepath/router-events.test.ts": "Pages Router rendering and data APIs",
  "test/e2e/edge-compiler-can-import-blob-assets/index.test.ts":
    "Worker/edge fetch and imported assets",
  "test/e2e/esm-externals/esm-externals.test.ts":
    "Module formats, externals, and package resolution",
  "test/e2e/externals-transitive/externals-transitive.test.ts":
    "Module formats, externals, and package resolution",
  "test/e2e/getserversideprops/test/index.test.ts": "Pages Router rendering and data APIs",
  "test/e2e/middleware-general/test/index.test.ts":
    "Middleware rewrites, query propagation, and trailing slash",
  "test/e2e/middleware-general/test/node-runtime.test.ts":
    "Middleware rewrites, query propagation, and trailing slash",
  "test/e2e/middleware-rewrites/test/index.test.ts":
    "Middleware rewrites, query propagation, and trailing slash",
  "test/e2e/middleware-trailing-slash/test/index.test.ts":
    "Middleware rewrites, query propagation, and trailing slash",
  "test/e2e/next-head/index.test.ts": "Pages Router rendering and data APIs",
  "test/e2e/prerender.test.ts": "ISR, tags, revalidation, and after()",
  "test/e2e/revalidate-reason/revalidate-reason.test.ts": "ISR, tags, revalidation, and after()",
  "test/e2e/streaming-ssr/index.test.ts": "CSS ordering, styled-jsx, and dynamic CSS",
  "test/e2e/tsconfig-path/index.test.ts": "next.config and custom tsconfig loading",
  "test/e2e/typescript-custom-tsconfig/test/index.test.ts":
    "next.config and custom tsconfig loading",
} as const satisfies Record<string, string>;

const DEFAULT_SUPPORT: SuiteSupport = {
  status: "supported",
  feature: null,
  reason: null,
};

export const NON_SUPPORTED_SUITES = Object.keys(SUITE_SUPPORT_POLICY);
export const CLASSIFIED_SUITES = [
  ...NON_SUPPORTED_SUITES,
  ...Object.keys(SUPPORTED_SUITE_FEATURES),
];

export function getSuiteSupport(suite: string): SuiteSupport {
  const scoped = SUITE_SUPPORT_POLICY[suite as keyof typeof SUITE_SUPPORT_POLICY];
  if (scoped) return scoped;

  const feature = SUPPORTED_SUITE_FEATURES[suite as keyof typeof SUPPORTED_SUITE_FEATURES];
  return feature ? { status: "supported", feature, reason: null } : DEFAULT_SUPPORT;
}
