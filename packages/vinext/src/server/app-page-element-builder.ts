import { createElement } from "react";
import { markDynamicUsage, markRenderRequestApiUsage } from "vinext/shims/headers";
import { makeThenableParams } from "vinext/shims/thenable-params";
import { resolveActiveParallelRouteHeadInputs, resolveAppPageHead } from "./app-page-head.js";
import {
  buildAppPageElements,
  createAppPageTreePath,
  type AppPageErrorModule,
  type AppPageModule,
  type AppPageRouteWiringRoute,
  type AppPageSlotOverride,
} from "./app-page-route-wiring.js";
import { AppElementsWire, type AppElements, type AppElementsInterception } from "./app-elements.js";
import type { AppPageParams } from "./app-page-boundary.js";
import { matchRoutePattern } from "../routing/route-pattern.js";
import { normalizePathnameForRouteMatch } from "../routing/utils.js";
import type { MetadataFileRoute } from "./metadata-routes.js";
import { APP_RSC_RENDER_MODE_NAVIGATION, type AppRscRenderMode } from "./app-rsc-render-mode.js";
import { isInterceptionMatchedUrlPath, normalizePath } from "./normalize-path.js";
import { hasDynamicMetadataModules, shouldStreamMetadata } from "./metadata-streaming.js";
import type { Metadata } from "vinext/shims/metadata";

export type { AppPageErrorModule, AppPageRouteWiringRoute } from "./app-page-route-wiring.js";

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
  interceptPage?: TModule | null;
  interceptParams?: AppPageParams | null;
  interceptSlotId?: string | null;
  interceptSlotKey?: string | null;
  interceptSourceMatchedUrl?: string | null;
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
};

export type BuildPageElementsOptions<
  TModule extends AppPageModule = AppPageModule,
  TErrorModule extends AppPageErrorModule = AppPageErrorModule,
> = {
  route: AppPageBuildRoute<TModule, TErrorModule>;
  params: AppPageParams;
  routePath: string;
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
    pageRequest,
    globalErrorModule,
    rootNotFoundModule,
    rootForbiddenModule,
    rootUnauthorizedModule,
    metadataRoutes,
  } = options;
  const {
    opts,
    searchParams,
    isRscRequest,
    mountedSlotsHeader,
    renderMode = APP_RSC_RENDER_MODE_NAVIGATION,
  } = pageRequest;

  const pageModule: AppPageModule | null | undefined = route.page;
  const PageComponent = pageModule?.default;
  const hasPageModule = !!pageModule;
  const interception = createAppPageInterceptionProof(routePath, opts);

  if (hasPageModule && !PageComponent) {
    const interceptionContext = opts?.interceptionContext ?? null;
    const noExportRouteId = AppElementsWire.encodeRouteId(routePath, interceptionContext);
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
        interception,
        interceptionContext,
        layoutIds: noExportLayoutIds,
        rootLayoutTreePath: noExportRootLayout,
        routeId: noExportRouteId,
      }),
      [noExportRouteId]: createElement("div", null, "Page has no default export"),
    };
  }

  // Decide whether to stream metadata into <body> (Next.js 15+ behavior) or
  // block on resolution and emit it into <head>. Streaming is only enabled
  // when the route has a `generateMetadata`/`generateViewport` somewhere AND
  // the request is not an HTML-only bot AND not an RSC navigation. The RSC
  // payload still needs fully-resolved metadata so the client router can put
  // it in the right place; streaming only applies to the initial document
  // SSR.
  const metadataModules: Array<Record<string, unknown> | null | undefined> = [
    ...route.layouts,
    route.page ?? null,
  ];
  const hasDynamic = hasDynamicMetadataModules(metadataModules);
  const userAgent = pageRequest.request.headers.get("user-agent");
  const useStreamingMetadata = shouldStreamMetadata({
    hasDynamic,
    userAgent,
    isRscRequest,
  });

  const headResolution = resolveAppPageHead({
    layoutModules: route.layouts,
    layoutTreePositions: route.layoutTreePositions,
    metadataRoutes,
    pageModule: route.page ?? null,
    parallelRoutes: resolveActiveParallelRouteHeadInputs({
      interceptLayouts: opts?.interceptLayouts ?? null,
      interceptPage: opts?.interceptPage ?? null,
      interceptParams: opts?.interceptParams ?? null,
      interceptSlotKey: opts?.interceptSlotKey ?? null,
      params,
      routeSegments: route.routeSegments ?? [],
      slots: route.slots ?? null,
    }),
    params,
    routePath: route.pattern,
    routeSegments: route.routeSegments ?? null,
    searchParams,
  });

  // Always await once to get search-params info (needed for page props) and
  // the resolved viewport (needed for the static head emission even in the
  // streaming path). When streaming, we forward the same promise into the
  // tree so React can stream the metadata tags into <body> via Suspense.
  const headSettled = await headResolution;
  const {
    hasSearchParams,
    metadata: resolvedMetadata,
    pageSearchParams,
    viewport: resolvedViewport,
  } = headSettled;

  // Defer the metadata promise across a microtask so React sees it as pending
  // when reaching the Suspense boundary. Without this, an already-resolved
  // promise gets inlined and React 19 Float hoists the `<title>` etc. to
  // `<head>` — defeating the purpose of streaming. The microtask deferral
  // also matches Next.js's behavior where the metadata resolves AFTER the
  // initial shell flushes.
  // NOTE (WIP): synchronously-resolved promise is not enough — see
  // `metadata-streaming.ts` for the open question about Suspense streaming
  // through the RSC->SSR pipeline. Even with a setTimeout-deferred promise
  // (tried up to 200ms), React still hoists the streamed <title> to <head>
  // because the RSC payload may already have the resolved chunk by the time
  // SSR begins consuming. Left here as scaffolding for the next iteration.
  const streamingMetadata: Promise<{ metadata: Metadata | null }> | null = useStreamingMetadata
    ? Promise.resolve({ metadata: resolvedMetadata })
    : null;

  const pageProps: Record<string, unknown> = { params: makeThenableParams(params) };
  if (searchParams) {
    pageProps.searchParams = makeThenableParams(pageSearchParams);
    if (hasSearchParams) {
      markDynamicUsage();
      markRenderRequestApiUsage("searchParams");
    }
  }

  const mountedSlotIds = mountedSlotsHeader ? new Set(mountedSlotsHeader.split(" ")) : null;

  const slotOverrides = buildSlotOverrides(route, params, routePath, opts);

  return buildAppPageElements({
    element: PageComponent ? createElement(PageComponent, pageProps) : null,
    globalErrorModule: globalErrorModule ?? null,
    isRscRequest,
    mountedSlotIds,
    makeThenableParams,
    matchedParams: params,
    // In streaming mode, suppress the resolvedMetadata from the synchronous
    // head emission so the static head only contains charset + viewport.
    // The same metadata will arrive via the streamingMetadata promise.
    resolvedMetadata: useStreamingMetadata ? null : resolvedMetadata,
    resolvedViewport,
    streamingMetadata,
    interceptionContext: opts?.interceptionContext ?? null,
    interception,
    routePath,
    rootNotFoundModule: rootNotFoundModule ?? null,
    rootForbiddenModule: rootForbiddenModule ?? null,
    rootUnauthorizedModule: rootUnauthorizedModule ?? null,
    route,
    slotOverrides,
    renderMode,
  });
}

function createAppPageInterceptionProof<TModule extends AppPageModule>(
  routePath: string,
  opts?: AppPageInterceptOptions<TModule> | null,
): AppElementsInterception | null {
  const sourceMatchedUrl = normalizeInterceptionProofMatchedUrl(
    opts?.interceptSourceMatchedUrl ?? null,
  );
  const targetMatchedUrl = normalizeInterceptionProofMatchedUrl(routePath);
  const slotId = opts?.interceptSlotId ?? null;
  if (sourceMatchedUrl === null || targetMatchedUrl === null || slotId === null) return null;

  return {
    sourceMatchedUrl,
    sourceRouteId: AppElementsWire.encodeRouteId(sourceMatchedUrl, null),
    slotId,
    targetMatchedUrl,
    targetRouteId: AppElementsWire.encodeRouteId(targetMatchedUrl, null),
  };
}

function normalizeInterceptionProofMatchedUrl(value: string | null): string | null {
  if (value === null || !isInterceptionMatchedUrlPath(value)) return null;

  return normalizePath(normalizePathnameForRouteMatch(value));
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

  if (opts && opts.interceptSlotKey && opts.interceptPage) {
    overrides[opts.interceptSlotKey] = {
      layoutModules: opts.interceptLayouts || null,
      pageModule: opts.interceptPage,
      params: opts.interceptParams || routeParams,
    };
  }

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

      const existing = overrides[slotKey];
      overrides[slotKey] = existing ? { ...existing, params: matched } : { params: matched };
    }
  }

  return Object.keys(overrides).length > 0 ? overrides : null;
}

function collectParamNameSet(params: readonly string[] | undefined | null): Set<string> {
  const set = new Set<string>();
  if (params) {
    for (const name of params) set.add(name);
  }
  return set;
}
