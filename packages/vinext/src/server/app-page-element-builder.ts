import { Suspense, createElement } from "react";
import { makeThenableParams } from "vinext/shims/thenable-params";
import {
  prepareAppPageHead,
  resolveActiveParallelRouteHeadInputs,
  type ApplyAppPageFileBasedMetadata,
} from "./app-page-head.js";
import {
  resolveHttpAccessFallbackMetadata,
  resolveHttpAccessFallbackViewport,
} from "./app-page-http-access-fallback-metadata.js";
import { SIBLING_PAGE_INTERCEPT_SLOT_KEY } from "./app-rsc-route-matching.js";
import {
  buildAppPageElements,
  createAppPageSourcePage,
  createAppPageTreePath,
  type AppPageErrorModule,
  type AppPageModule,
  type AppPageRouteWiringRoute,
  type AppPageSlotOverride,
} from "./app-page-route-wiring.js";
import { AppElementsWire, type AppElements } from "./app-elements.js";
import { resolveAppPageParentHttpAccessBoundary, type AppPageParams } from "./app-page-boundary.js";
import { resolveAppPageSpecialError } from "./app-page-execution.js";
import { sanitizeErrorForClient } from "./app-rsc-errors.js";
import { DEFAULT_GLOBAL_ERROR_MODULE } from "./default-global-error-module.js";
import { matchRoutePattern } from "../routing/route-pattern.js";
import type { MetadataFileRoute } from "./metadata-routes.js";
import { APP_RSC_RENDER_MODE_NAVIGATION, type AppRscRenderMode } from "./app-rsc-render-mode.js";
import type { AppLayoutParamAccessTracker } from "./app-layout-param-observation.js";
import { createAppPageRenderIdentity } from "./app-page-render-identity.js";
import {
  createAppPageSearchParamsObserver,
  makeObservedAppPageSearchParamsThenable,
} from "./app-page-search-params-observation.js";
import { shouldServeStreamingMetadata } from "./streaming-metadata.js";
import { resolveAppPageBranchParams, resolveAppPageSegmentParams } from "./app-page-params.js";

function resolveInterceptLayoutParams(
  branchSegments: readonly string[],
  layoutSegments: readonly string[],
  params: AppPageParams,
): AppPageParams {
  return resolveAppPageBranchParams(branchSegments, layoutSegments.length, params, layoutSegments);
}

export type { AppPageErrorModule, AppPageRouteWiringRoute } from "./app-page-route-wiring.js";

type AppPageComponent = NonNullable<AppPageModule["default"]>;
const REACT_CLIENT_REFERENCE = Symbol.for("react.client.reference");

function isReactOwnedPageComponent(component: AppPageComponent): boolean {
  if (typeof component !== "function") {
    return true;
  }
  const candidate = component as AppPageComponent & {
    $$typeof?: symbol;
    prototype?: { isReactComponent?: unknown };
  };
  return (
    candidate.$$typeof === REACT_CLIENT_REFERENCE || candidate.prototype?.isReactComponent != null
  );
}

/**
 * Route shape passed from the generated entry. Extends the wiring route with
 * the page module reference (used to extract the default export for the page
 * element) and the URL pattern (used as the route path in head resolution).
 */
export type AppPageBuildRoute<
  TModule extends AppPageModule = AppPageModule,
  TErrorModule extends AppPageErrorModule = AppPageErrorModule,
> = AppPageRouteWiringRoute<TModule, TErrorModule> & {
  page?: TModule | null;
  pattern: string;
  /** Param names captured by the route's URL pattern, in order. */
  params?: readonly string[] | null;
};

export type AppPageInterceptOptions<TModule extends AppPageModule = AppPageModule> = {
  interceptionContext?: string | null;
  interceptLayouts?: readonly (TModule | null | undefined)[] | null;
  interceptLayoutSegments?: readonly (readonly string[])[] | null;
  interceptBranchSegments?: readonly string[] | null;
  interceptLoadings?: readonly (TModule | null | undefined)[] | null;
  interceptLoadingTreePositions?: readonly number[] | null;
  interceptNotFoundBranchSegments?: readonly string[] | null;
  interceptNotFound?: TModule | null;
  interceptNotFoundTreePosition?: number | null;
  interceptPage?: TModule | null;
  interceptParams?: AppPageParams | null;
  interceptSlotId?: string | null;
  interceptSlotKey?: string | null;
  interceptSourceMatchedUrl?: string | null;
  interceptSourcePageSegments?: readonly string[] | null;
};

export type AppPagePageRequest<TModule extends AppPageModule = AppPageModule> = {
  /** Interception context from current-route navigation (null for direct visits). */
  opts?: AppPageInterceptOptions<TModule> | null;
  /** URL search params from the incoming request (null when unavailable). */
  searchParams?: URLSearchParams | null;
  /** Whether the incoming request is an RSC (client-side navigation) request. */
  isRscRequest: boolean;
  /** The incoming HTTP request (available but unused by this module). */
  request: Request;
  /** Normalized x-vinext-mounted-slots header value. */
  mountedSlotsHeader: string | null;
  /** Semantic RSC payload mode for this page render. */
  renderMode?: AppRscRenderMode;
  /** Observe page `searchParams` access for cache-safety classification. */
  observePageSearchParamsAccess?: boolean;
  /** Observe page metadata `searchParams` access for cache-safety classification. */
  observeMetadataSearchParamsAccess?: boolean;
  /** Whether generated metadata may stream into the response body. */
  serveStreamingMetadata?: boolean;
  /** Whether streamed render errors must be sanitized for client transport. */
  isProduction?: boolean;
};

export type BuildPageElementsOptions<
  TModule extends AppPageModule = AppPageModule,
  TErrorModule extends AppPageErrorModule = AppPageErrorModule,
> = {
  applyFileBasedMetadata?: ApplyAppPageFileBasedMetadata;
  route: AppPageBuildRoute<TModule, TErrorModule>;
  params: AppPageParams;
  routePath: string;
  displayPathname?: string;
  pageRequest: AppPagePageRequest<TModule>;
  /** Root-level global-error.tsx module. Present when the app defines this file. */
  globalErrorModule?: TErrorModule | null;
  /** Root-level not-found.tsx module. Present when the app defines this file. */
  rootNotFoundModule?: TModule | null;
  /** Root-level forbidden.tsx module. Present when the app defines this file. */
  rootForbiddenModule?: TModule | null;
  /** Root-level unauthorized.tsx module. Present when the app defines this file. */
  rootUnauthorizedModule?: TModule | null;
  /** File-based metadata routes (favicon, manifest, sitemap, etc.). */
  metadataRoutes: readonly MetadataFileRoute[];
  layoutParamAccess?: AppLayoutParamAccessTracker;
  /**
   * Configured next.config `basePath`. Threaded through `resolveAppPageHead`
   * so file-based metadata route URLs emitted in <head> are prefixed.
   */
  basePath?: string;
  /** Configured next.config `trailingSlash`, threaded into canonical URL rendering. */
  trailingSlash?: boolean;
  /** Serialized next.config `htmlLimitedBots` regexp source. */
  htmlLimitedBots?: string;
};

type AppPageNavigationParamModule = {
  default?: unknown;
};

type AppPageNavigationParamSlot = {
  default?: AppPageNavigationParamModule | null;
  page?: AppPageNavigationParamModule | null;
  slotPatternParts?: readonly string[] | null;
  slotParamNames?: readonly string[] | null;
};

type AppPageNavigationParamRoute = {
  params?: readonly string[] | null;
  slots?: Readonly<Record<string, AppPageNavigationParamSlot>> | null;
};

type AppPageNavigationParamInterceptOptions = {
  interceptPage?: unknown;
  interceptParams?: AppPageParams | null;
  interceptSlotKey?: string | null;
};

/**
 * Build the App Router element tree for a matched route.
 *
 * This is the central element-construction path for the App Router RSC
 * handler. It resolves page head metadata (including parallel route metadata),
 * creates the page React element, and wires it into the nested layout +
 * boundary tree via {@link buildAppPageElements}.
 *
 * The function is extracted from the generated RSC entry template so it can
 * be unit-tested independently of the code-generation machinery.
 *
 * Next.js equivalent: the component tree construction in
 * {@link https://github.com/vercel/next.js/blob/canary/packages/next/src/server/app-render/create-component-tree.tsx|create-component-tree.tsx}
 * and the page head resolution in
 * {@link https://github.com/vercel/next.js/blob/canary/packages/next/src/server/app-render/create-metadata.tsx|create-metadata.tsx}.
 */
export async function buildPageElements<
  TModule extends AppPageModule = AppPageModule,
  TErrorModule extends AppPageErrorModule = AppPageErrorModule,
>(options: BuildPageElementsOptions<TModule, TErrorModule>): Promise<AppElements> {
  const {
    route,
    params,
    routePath,
    displayPathname = routePath,
    pageRequest,
    globalErrorModule,
    rootNotFoundModule,
    rootForbiddenModule,
    rootUnauthorizedModule,
    metadataRoutes,
  } = options;
  const slotParamOverrides = resolveSlotParamOverrides(route, routePath);
  const {
    opts,
    searchParams,
    isRscRequest,
    mountedSlotsHeader,
    renderMode = APP_RSC_RENDER_MODE_NAVIGATION,
    observeMetadataSearchParamsAccess = false,
    observePageSearchParamsAccess = false,
    serveStreamingMetadata,
    isProduction = process.env.NODE_ENV === "production",
  } = pageRequest;

  const pageModule: AppPageModule | null | undefined = route.page;

  // Sibling intercepts replace the full page — the intercepting page is the
  // effective page module. Slot-based intercepts use a different code path
  // (buildSlotOverrides) and are unaffected.
  const isSiblingIntercept =
    opts?.interceptSlotKey === SIBLING_PAGE_INTERCEPT_SLOT_KEY && !!opts?.interceptPage;
  const effectivePageModule = isSiblingIntercept
    ? (opts!.interceptPage as AppPageModule | null | undefined)
    : pageModule;
  // Resolve the component that will actually render. For a sibling intercept
  // this is the intercepting page's own default export — we deliberately do
  // NOT fall back to the source route's page component. Silently rendering a
  // *different* page than the requested intercept is a surprising failure mode;
  // a missing default export is surfaced as an explicit error below, mirroring
  // the source/slot no-export handling. For a normal request this is identical
  // to `pageModule?.default` since `effectivePageModule === pageModule`.
  const EffectivePageComponent = effectivePageModule?.default;
  const effectiveParams = isSiblingIntercept ? (opts!.interceptParams ?? params) : params;
  const sourcePageSegments = isSiblingIntercept
    ? opts?.interceptSourcePageSegments
    : route.routeSegments;

  const hasPageModule = !!pageModule;
  const renderIdentity = createAppPageRenderIdentity({
    displayPathname,
    matchedRoutePathname: routePath,
    targetMatchedPathname: routePath,
    interceptionContext: opts?.interceptionContext ?? null,
    interceptSourceMatchedUrl: opts?.interceptSourceMatchedUrl ?? null,
    // Sibling intercepts are full-page replacements with no slot proof.
    // Passing null here makes the payload carry interception:null so the
    // client planner commits the result as a normal navigation rather than
    // attempting slot-preservation validation (which would fail — the
    // synthetic __page slot has no real slot binding in the component tree).
    interceptSlotId: isSiblingIntercept ? null : (opts?.interceptSlotId ?? null),
  });

  // Surface a clear "no default export" error for whichever page will render:
  // the source route page on a normal request, or the intercepting page for a
  // sibling intercept. Without the `isSiblingIntercept` arm, an intercepting
  // page missing its default export would silently render the source page.
  if ((hasPageModule || isSiblingIntercept) && !EffectivePageComponent) {
    let noExportRootLayout: string | null = null;
    const noExportLayoutIds =
      route.ids?.layouts ??
      route.layouts.map((_, index) =>
        AppElementsWire.encodeLayoutId(
          createAppPageTreePath(route.routeSegments, route.layoutTreePositions?.[index] ?? 0),
        ),
      );
    if (route.layouts?.length > 0) {
      const treePosition = route.layoutTreePositions?.[0] ?? 0;
      noExportRootLayout = createAppPageTreePath(route.routeSegments, treePosition);
    }
    return {
      ...AppElementsWire.createMetadataEntries({
        interception: renderIdentity.interception,
        interceptionContext: renderIdentity.interceptionContext,
        layoutIds: noExportLayoutIds,
        rootLayoutTreePath: noExportRootLayout,
        routeId: renderIdentity.routeId,
        sourcePage: createAppPageSourcePage(sourcePageSegments),
      }),
      [renderIdentity.routeId]: createElement("div", null, "Page has no default export"),
    };
  }

  const activeParallelRouteHeadInputs = resolveActiveParallelRouteHeadInputs({
    interceptBranchSegments: opts?.interceptBranchSegments ?? null,
    interceptLayouts: opts?.interceptLayouts ?? null,
    interceptLayoutSegments: opts?.interceptLayoutSegments ?? null,
    interceptNotFoundBranchSegments: opts?.interceptNotFoundBranchSegments ?? null,
    interceptNotFound: opts?.interceptNotFound ?? null,
    interceptNotFoundTreePosition: opts?.interceptNotFoundTreePosition ?? null,
    interceptPage: opts?.interceptPage ?? null,
    interceptParams: opts?.interceptParams ?? null,
    interceptSlotKey: opts?.interceptSlotKey ?? null,
    interceptSourcePageSegments: opts?.interceptSourcePageSegments ?? null,
    layoutTreePositions: route.layoutTreePositions,
    params,
    routeSegments: route.routeSegments ?? [],
    slotParams: slotParamOverrides,
    slots: route.slots ?? null,
  });
  const primaryParallelRouteHeadInput = isSiblingIntercept
    ? {
        head: {
          layoutModules: opts?.interceptLayouts ?? [],
          layoutParams: (opts?.interceptLayoutSegments ?? []).map((segments) =>
            resolveInterceptLayoutParams(
              opts?.interceptBranchSegments ?? segments,
              segments,
              effectiveParams,
            ),
          ),
          pageModule: effectivePageModule ?? null,
          params: effectiveParams,
          routeSegments: opts?.interceptSourcePageSegments ?? route.routeSegments ?? [],
        },
        ...(opts?.interceptNotFound
          ? {
              notFoundModule: opts.interceptNotFound,
              notFoundParams: resolveAppPageBranchParams(
                opts.interceptNotFoundBranchSegments ??
                  opts.interceptBranchSegments ??
                  route.routeSegments ??
                  [],
                opts.interceptNotFoundTreePosition ?? 0,
                effectiveParams,
              ),
            }
          : {}),
        ownerTreePosition: route.routeSegments?.length ?? 0,
      }
    : null;
  const parallelRoutes = [
    ...activeParallelRouteHeadInputs.map((input) => input.head),
    ...(primaryParallelRouteHeadInput ? [primaryParallelRouteHeadInput.head] : []),
  ];
  const metadataSearchParamsObserver = observeMetadataSearchParamsAccess
    ? createAppPageSearchParamsObserver()
    : undefined;
  const preparedHead = prepareAppPageHead({
    applyFileBasedMetadata: options.applyFileBasedMetadata,
    basePath: options.basePath ?? "",
    layoutModules: route.layouts,
    layoutTreePositions: route.layoutTreePositions,
    metadataRoutes,
    pageModule: isSiblingIntercept ? null : (effectivePageModule ?? null),
    parallelRoutes,
    params: effectiveParams,
    routePath: route.pattern,
    routeSegments: route.routeSegments ?? null,
    searchParams,
    searchParamsObserver: metadataSearchParamsObserver,
  });
  const { hasDynamicMetadata, pageSearchParams } = preparedHead;
  const streamGeneratedHead =
    serveStreamingMetadata ??
    shouldServeStreamingMetadata(
      pageRequest.request.headers.get("user-agent") ?? "",
      options.htmlLimitedBots,
    );
  const metadataPlacement = hasDynamicMetadata && streamGeneratedHead ? "body" : "head";
  // Streaming HTML and Flight responses share the unresolved promise between
  // the Suspense tag branch and its in-boundary error outlet. Late navigation
  // signals remain encoded in the Flight digest; response headers are only an
  // early optimization and must not make generated metadata block navigation.
  const shouldDeferMetadata = metadataPlacement === "body";
  const streamingMetadata = shouldDeferMetadata
    ? isProduction
      ? preparedHead.metadata.catch((error) => {
          throw sanitizeErrorForClient(error, "production");
        })
      : preparedHead.metadata
    : null;
  // Viewport resolution can keep us below from wiring the paired outlet for
  // another event-loop turn. Observe an early metadata rejection immediately;
  // the original promise remains rejected for the real outlet consumer.
  void streamingMetadata?.catch(() => null);

  const resolveNotFoundFallbackPlanOptions = () => {
    const routeBoundaryModule = route.notFound;
    const parentBoundary = resolveAppPageParentHttpAccessBoundary({
      layoutIndex: route.layouts.length,
      rootForbiddenModule,
      rootNotFoundModule,
      rootUnauthorizedModule,
      routeForbiddenModules: route.forbiddens,
      routeNotFoundModules: route.notFounds,
      routeUnauthorizedModules: route.unauthorizeds,
      statusCode: 404,
    });
    const boundaryModule = routeBoundaryModule ?? parentBoundary.module;
    const boundaryTreePosition = routeBoundaryModule
      ? route.notFoundTreePosition
      : parentBoundary.layoutIndex === null
        ? null
        : route.layoutTreePositions?.[parentBoundary.layoutIndex];
    const boundaryParams =
      boundaryModule && boundaryTreePosition != null
        ? resolveAppPageSegmentParams(
            route.routeSegments ?? [],
            boundaryTreePosition,
            effectiveParams,
          )
        : {};
    return {
      boundaryModule,
      boundaryParams,
      layoutModules: route.layouts,
      layoutTreePositions: route.layoutTreePositions,
      parallelBranches: activeParallelRouteHeadInputs,
      params: effectiveParams,
      primaryParallelBranch: primaryParallelRouteHeadInput,
      routeSegments: route.routeSegments ?? null,
    };
  };

  let viewportErrorOutlet: Promise<never> | null = null;
  let metadataErrorOutlet: Promise<never> | null = null;
  const resolveMetadataErrorTags = async (error: unknown) => {
    const specialError = resolveAppPageSpecialError(error);
    if (specialError?.kind !== "http-access-fallback") return null;

    // Next resolves the not-found metadata convention for every HTTP access
    // fallback. Errors from that fallback tag branch are suppressed because
    // the original digest is still rethrown by the paired outlet.
    return resolveHttpAccessFallbackMetadata({
      applyFileBasedMetadata: options.applyFileBasedMetadata,
      basePath: options.basePath ?? "",
      ...resolveNotFoundFallbackPlanOptions(),
      metadataRoutes,
      routePath: route.pattern,
    }).catch(() => null);
  };
  const [resolvedMetadata, resolvedViewport] = await Promise.all([
    shouldDeferMetadata
      ? Promise.resolve(null)
      : preparedHead.metadata.catch((error) => {
          metadataErrorOutlet = Promise.reject(
            isProduction ? sanitizeErrorForClient(error, "production") : error,
          );
          void metadataErrorOutlet.catch(() => null);
          return resolveMetadataErrorTags(error);
        }),
    preparedHead.viewport.catch(async (error) => {
      const specialError = resolveAppPageSpecialError(error);

      viewportErrorOutlet = Promise.reject(
        isProduction ? sanitizeErrorForClient(error, "production") : error,
      );
      void viewportErrorOutlet.catch(() => null);
      return specialError?.kind === "http-access-fallback"
        ? resolveHttpAccessFallbackViewport(resolveNotFoundFallbackPlanOptions()).catch(() => ({}))
        : {};
    }),
  ]);
  const streamingMetadataTags = shouldDeferMetadata
    ? preparedHead.metadata.catch(resolveMetadataErrorTags)
    : null;
  const streamingMetadataOutletInputs = [
    streamingMetadata,
    metadataErrorOutlet,
    viewportErrorOutlet,
  ]
    .filter((promise) => promise !== null)
    .map((promise) => Promise.resolve(promise));
  const streamingMetadataOutlet =
    streamingMetadataOutletInputs.length > 0
      ? Promise.all(streamingMetadataOutletInputs).then(() => null)
      : null;
  void streamingMetadataOutlet?.catch(() => null);

  const pageProps: Record<string, unknown> = { params: makeThenableParams(effectiveParams) };
  const hasRequestSearchParams = Object.keys(pageSearchParams).length > 0;
  const createPageElement = (
    PageComponent: AppPageComponent,
    props: Readonly<Record<string, unknown>>,
  ) => {
    if (isReactOwnedPageComponent(PageComponent)) {
      const invocationProps = { ...props };
      if (searchParams) {
        invocationProps.searchParams = observePageSearchParamsAccess
          ? makeObservedAppPageSearchParamsThenable(pageSearchParams, {
              markDynamic: hasRequestSearchParams,
            })
          : makeThenableParams(pageSearchParams);
      }
      return createElement(PageComponent, invocationProps);
    }

    const ServerPageComponent = PageComponent as unknown as (
      props: Readonly<Record<string, unknown>>,
    ) => ReturnType<typeof createElement> | Promise<unknown> | string | number | null;
    const PageInvoker = () => {
      const invocationProps = { ...props };
      if (searchParams) {
        invocationProps.searchParams = observePageSearchParamsAccess
          ? makeObservedAppPageSearchParamsThenable(pageSearchParams)
          : makeThenableParams(pageSearchParams);
      }
      return ServerPageComponent(invocationProps);
    };
    return createElement(PageInvoker as unknown as AppPageComponent);
  };
  const pageSearchParamsThenable = searchParams ? makeThenableParams(pageSearchParams) : undefined;

  const mountedSlotIds = mountedSlotsHeader ? new Set(mountedSlotsHeader.split(" ")) : null;

  const slotOverrides = buildSlotOverrides(route, params, routePath, opts);
  // For sibling intercepts, wrap the intercepting page in any layouts that
  // live under the interception marker directory (interceptLayouts). In Next.js
  // the intercepting route's segment layouts wrap the intercepting page; the
  // slot-based path handles this inside buildSlotOverrides/app-page-route-wiring,
  // but sibling intercepts bypass that path entirely. We apply the wrapping here
  // so a layout.tsx adjacent to the (.) / (..) / (...) marker dir is respected.
  let siblingInterceptElement: ReturnType<typeof createElement> | null =
    isSiblingIntercept && EffectivePageComponent
      ? createPageElement(EffectivePageComponent, pageProps)
      : null;
  if (isSiblingIntercept && siblingInterceptElement !== null) {
    const layoutIndexesByTreePosition = new Map<number, number[]>();
    for (const [index, layoutModule] of (opts?.interceptLayouts ?? []).entries()) {
      if (!layoutModule?.default) continue;
      const treePosition = opts?.interceptLayoutSegments?.[index]?.length ?? 0;
      const indexes = layoutIndexesByTreePosition.get(treePosition) ?? [];
      indexes.push(index);
      layoutIndexesByTreePosition.set(treePosition, indexes);
    }
    const loadingIndexesByTreePosition = new Map<number, number>();
    for (const [index, loadingModule] of (opts?.interceptLoadings ?? []).entries()) {
      if (!loadingModule?.default) continue;
      const treePosition = opts?.interceptLoadingTreePositions?.[index];
      if (treePosition !== undefined) loadingIndexesByTreePosition.set(treePosition, index);
    }
    const treePositions = Array.from(
      new Set([...layoutIndexesByTreePosition.keys(), ...loadingIndexesByTreePosition.keys()]),
    ).sort((left, right) => left - right);

    for (let index = treePositions.length - 1; index >= 0; index--) {
      const treePosition = treePositions[index];
      const loadingIndex = loadingIndexesByTreePosition.get(treePosition);
      const LoadingComponent =
        loadingIndex === undefined ? null : opts?.interceptLoadings?.[loadingIndex]?.default;
      if (LoadingComponent) {
        siblingInterceptElement = createElement(
          Suspense,
          { fallback: createElement(LoadingComponent) },
          siblingInterceptElement,
        );
      }

      const layoutIndexes = layoutIndexesByTreePosition.get(treePosition) ?? [];
      for (let layoutOffset = layoutIndexes.length - 1; layoutOffset >= 0; layoutOffset--) {
        const layoutIndex = layoutIndexes[layoutOffset];
        const LayoutComponent = opts?.interceptLayouts?.[layoutIndex]?.default;
        if (!LayoutComponent) continue;
        const interceptLayoutSegments = opts?.interceptLayoutSegments?.[layoutIndex] ?? [];
        const interceptLayoutParams = resolveInterceptLayoutParams(
          opts?.interceptBranchSegments ?? interceptLayoutSegments,
          interceptLayoutSegments,
          effectiveParams,
        );
        siblingInterceptElement = createElement(
          LayoutComponent,
          { params: makeThenableParams(interceptLayoutParams) },
          siblingInterceptElement,
        );
      }
    }
  }

  return buildAppPageElements({
    element: isSiblingIntercept
      ? siblingInterceptElement
      : EffectivePageComponent
        ? createPageElement(EffectivePageComponent, pageProps)
        : null,
    createPageElement,
    // Fall back to vinext's built-in default global error module so that
    // uncaught client render errors are caught by the route-level
    // <ErrorBoundary> wrapper in app-page-route-wiring.tsx, mirroring
    // Next.js's behavior when the user has not defined app/global-error.tsx.
    globalErrorModule:
      globalErrorModule ?? (DEFAULT_GLOBAL_ERROR_MODULE as unknown as TErrorModule),
    isRscRequest,
    layoutParamAccess: options.layoutParamAccess,
    mountedSlotIds,
    makeThenableParams,
    matchedParams: params,
    metadataPlacement,
    resolvedMetadata,
    resolvedMetadataPathname: routePath,
    resolvedViewport,
    streamingMetadata,
    streamingMetadataOutlet,
    streamingMetadataOutletSuspended: streamGeneratedHead,
    streamingMetadataTags,
    renderIdentity,
    routePath,
    sourcePageSegments,
    rootNotFoundModule: rootNotFoundModule ?? null,
    rootForbiddenModule: rootForbiddenModule ?? null,
    rootUnauthorizedModule: rootUnauthorizedModule ?? null,
    route,
    searchParams: pageSearchParamsThenable,
    slotOverrides,
    renderMode,
    trailingSlash: options.trailingSlash,
  });
}

/**
 * Build the per-request `slotOverrides` map. Combines:
 *  - Interception overrides (existing behavior — swap in the intercepting page
 *    and its layouts when the request is intercepted into this slot).
 *  - Slot-specific param extraction for inherited slots whose URL pattern
 *    has different param names than the route's. The runtime matches the
 *    cleaned request path against `slot.slotPatternParts` to produce
 *    slot-scoped params, which `app-page-route-wiring` then hands to the
 *    slot page instead of the route's matched params.
 *
 * `routePath` is the already-normalized request pathname (basePath stripped,
 * RSC suffix removed). Re-parsing `request.url` here would re-introduce the
 * basePath and silently break the match for any app that configures one.
 */
function buildSlotOverrides<TModule extends AppPageModule, TErrorModule extends AppPageErrorModule>(
  route: AppPageBuildRoute<TModule, TErrorModule>,
  routeParams: AppPageParams,
  routePath: string,
  opts?: AppPageInterceptOptions<TModule> | null,
): Readonly<Record<string, AppPageSlotOverride<TModule>>> | null {
  const overrides: Record<string, AppPageSlotOverride<TModule>> = {};

  if (
    opts &&
    opts.interceptSlotKey &&
    opts.interceptPage &&
    opts.interceptSlotKey !== SIBLING_PAGE_INTERCEPT_SLOT_KEY
  ) {
    overrides[opts.interceptSlotKey] = {
      branchSegments: opts.interceptBranchSegments ?? null,
      layoutModules: opts.interceptLayouts || null,
      layoutSegments: opts.interceptLayoutSegments ?? null,
      loadingModules: opts.interceptLoadings || null,
      loadingTreePositions: opts.interceptLoadingTreePositions ?? null,
      pageModule: opts.interceptPage,
      params: opts.interceptParams || routeParams,
      routeSegments: resolveInterceptedSlotSegments(
        opts.interceptSourcePageSegments,
        opts.interceptSlotKey,
      ),
    };
  }

  const slotParamOverrides = resolveSlotParamOverrides(route, routePath);
  for (const [slotKey, params] of Object.entries(slotParamOverrides ?? {})) {
    const existing = overrides[slotKey];
    overrides[slotKey] = existing ? { ...existing, params: existing.params ?? params } : { params };
  }

  return Object.keys(overrides).length > 0 ? overrides : null;
}

export function resolveInterceptedSlotSegments(
  sourcePageSegments: readonly string[] | null | undefined,
  slotKey: string,
): readonly string[] | null {
  if (!sourcePageSegments) return null;

  const markerTraversals = [
    { prefix: "(...)", levels: Number.POSITIVE_INFINITY },
    { prefix: "(..)(..)", levels: 2 },
    { prefix: "(..)", levels: 1 },
    { prefix: "(.)", levels: 0 },
  ] as const;
  const markerIndex = sourcePageSegments.findIndex((segment) =>
    markerTraversals.some(({ prefix }) => segment.startsWith(prefix)),
  );
  if (markerIndex < 0) return null;

  const slotPathSeparator = slotKey.indexOf("@");
  const slotPath = slotPathSeparator >= 0 ? slotKey.slice(slotPathSeparator + 1) : "";
  const ownerSegments = slotPath.split("/").filter(Boolean);
  let segmentStart = ownerSegments.length;

  if (
    segmentStart === 0 ||
    segmentStart > markerIndex ||
    !ownerSegments.every((segment, index) => sourcePageSegments[index] === segment)
  ) {
    let slotName: string | null = null;
    for (let index = ownerSegments.length - 1; index >= 0; index--) {
      if (ownerSegments[index].startsWith("@")) {
        slotName = ownerSegments[index];
        break;
      }
    }

    let slotIndex = -1;
    if (slotName) {
      for (let index = markerIndex - 1; index >= 0; index--) {
        if (sourcePageSegments[index] === slotName) {
          slotIndex = index;
          break;
        }
      }
    }
    if (slotIndex < 0) return null;
    segmentStart = slotIndex + 1;
  }

  const routeSegments = sourcePageSegments
    .slice(segmentStart, markerIndex)
    .filter(
      (segment) => !segment.startsWith("@") && !(segment.startsWith("(") && segment.endsWith(")")),
    );
  const markerSegment = sourcePageSegments[markerIndex];
  const marker = markerTraversals.find(({ prefix }) => markerSegment.startsWith(prefix));
  if (!marker) return null;

  if (Number.isFinite(marker.levels)) {
    routeSegments.splice(Math.max(0, routeSegments.length - marker.levels), marker.levels);
  } else {
    routeSegments.length = 0;
  }

  const targetSegment = markerSegment.slice(marker.prefix.length);
  if (targetSegment) routeSegments.push(targetSegment);

  routeSegments.push(
    ...sourcePageSegments
      .slice(markerIndex + 1)
      .filter(
        (segment) =>
          !segment.startsWith("@") && !(segment.startsWith("(") && segment.endsWith(")")),
      ),
  );

  return routeSegments;
}

export function resolveSlotParamOverrides(
  route: AppPageNavigationParamRoute,
  routePath: string,
): Readonly<Record<string, AppPageParams>> | null {
  const overrides: Record<string, AppPageParams> = {};
  const slots = route.slots;
  if (slots) {
    let urlParts: string[] | null = null;
    const routeParamSet = collectParamNameSet(route.params);
    for (const [slotKey, slot] of Object.entries(slots)) {
      const patternParts = slot.slotPatternParts;
      const paramNames = slot.slotParamNames;
      if (!patternParts || patternParts.length === 0) continue;
      // Skip when every slot param is already a route param — the route's
      // matched params already carry the values the slot page expects.
      // Empty `paramNames` (slot pattern has no dynamic markers) also skips:
      // there's nothing to extract, so the route's matched params suffice.
      if (paramNames && paramNames.every((name) => routeParamSet.has(name))) continue;

      if (urlParts === null) {
        urlParts = routePath.split("/").filter(Boolean);
      }
      const matched = matchRoutePattern(urlParts, patternParts);
      if (!matched) continue;

      overrides[slotKey] = matched;
    }
  }

  return Object.keys(overrides).length > 0 ? overrides : null;
}

function mergeAppPageParams(target: AppPageParams, source: AppPageParams): void {
  for (const [key, value] of Object.entries(source)) {
    target[key] = value;
  }
}

function isDefaultExportModule(module: unknown): module is AppPageNavigationParamModule {
  return typeof module === "object" && module !== null;
}

function hasDefaultExport(module: unknown): boolean {
  if (!isDefaultExportModule(module)) return false;
  return module?.default !== null && module?.default !== undefined;
}

export function resolveAppPageNavigationParams(
  route: AppPageNavigationParamRoute,
  routeParams: AppPageParams,
  routePath: string,
  opts?: AppPageNavigationParamInterceptOptions | null,
): AppPageParams {
  const navigationParams: AppPageParams = { ...routeParams };
  const slotParamOverrides = resolveSlotParamOverrides(route, routePath);

  for (const [slotKey, slot] of Object.entries(route.slots ?? {})) {
    const isInterceptedSlot =
      opts?.interceptSlotKey === slotKey &&
      opts.interceptSlotKey !== SIBLING_PAGE_INTERCEPT_SLOT_KEY &&
      hasDefaultExport(opts.interceptPage);
    // A slot is considered active here if it exports a default component (page or fallback).
    // This is distinct from the optimistic-routing path (which keys off manifest bindings)
    // and the route graph (which keys off pagePath existence), but functionally equivalent
    // for param extraction today since default-only slots do not specify pattern parts.
    if (!isInterceptedSlot && !hasDefaultExport(slot.page) && !hasDefaultExport(slot.default)) {
      continue;
    }

    mergeAppPageParams(
      navigationParams,
      isInterceptedSlot
        ? (opts?.interceptParams ?? routeParams)
        : // Fallback to routeParams when slotParamOverrides missing — the slot
          // is active but contributes no new params (all its param names are
          // already route params, or the slot has no pattern parts). Merging
          // routeParams here is a deliberate no-op that keeps the loop uniform.
          (slotParamOverrides?.[slotKey] ?? routeParams),
    );
  }

  return navigationParams;
}

function collectParamNameSet(params: readonly string[] | undefined | null): Set<string> {
  const set = new Set<string>();
  if (params) {
    for (const name of params) set.add(name);
  }
  return set;
}
