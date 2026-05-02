import { createElement } from "react";
import { markDynamicUsage } from "../shims/headers.js";
import { makeThenableParams } from "../shims/thenable-params.js";
import { resolveActiveParallelRouteHeadInputs, resolveAppPageHead } from "./app-page-head.js";
import {
  buildAppPageElements,
  createAppPageTreePath,
  type AppPageErrorModule,
  type AppPageModule,
  type AppPageRouteWiringRoute,
} from "./app-page-route-wiring.js";
import {
  APP_INTERCEPTION_CONTEXT_KEY,
  createAppPayloadRouteId,
  type AppElements,
} from "./app-elements.js";
import type { AppPageParams } from "./app-page-boundary.js";
import type { MetadataFileRoute } from "./metadata-routes.js";

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
};

export type AppPageInterceptOptions<TModule extends AppPageModule = AppPageModule> = {
  interceptionContext?: string | null;
  interceptLayouts?: readonly (TModule | null | undefined)[] | null;
  interceptPage?: TModule | null;
  interceptParams?: AppPageParams | null;
  interceptSlotKey?: string | null;
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
  const { opts, searchParams, isRscRequest, mountedSlotsHeader } = pageRequest;

  const pageModule: AppPageModule | null | undefined = route.page;
  const PageComponent = pageModule?.default;
  const hasPageModule = !!pageModule;

  if (hasPageModule && !PageComponent) {
    const interceptionContext = opts?.interceptionContext ?? null;
    const noExportRouteId = createAppPayloadRouteId(routePath, interceptionContext);
    let noExportRootLayout: string | null = null;
    if (route.layouts?.length > 0) {
      const treePosition = route.layoutTreePositions?.[0] ?? 0;
      noExportRootLayout = createAppPageTreePath(route.routeSegments, treePosition);
    }
    return {
      [APP_INTERCEPTION_CONTEXT_KEY]: interceptionContext,
      __route: noExportRouteId,
      __rootLayout: noExportRootLayout,
      [noExportRouteId]: createElement("div", null, "Page has no default export"),
    };
  }

  const {
    hasSearchParams,
    metadata: resolvedMetadata,
    pageSearchParams,
    viewport: resolvedViewport,
  } = await resolveAppPageHead({
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

  const pageProps: Record<string, unknown> = { params: makeThenableParams(params) };
  if (searchParams) {
    pageProps.searchParams = makeThenableParams(pageSearchParams);
    if (hasSearchParams) markDynamicUsage();
  }

  const mountedSlotIds = mountedSlotsHeader ? new Set(mountedSlotsHeader.split(" ")) : null;

  return buildAppPageElements({
    element: PageComponent ? createElement(PageComponent, pageProps) : null,
    globalErrorModule: globalErrorModule ?? null,
    isRscRequest,
    mountedSlotIds,
    makeThenableParams,
    matchedParams: params,
    resolvedMetadata,
    resolvedViewport,
    interceptionContext: opts?.interceptionContext ?? null,
    routePath,
    rootNotFoundModule: rootNotFoundModule ?? null,
    rootForbiddenModule: rootForbiddenModule ?? null,
    rootUnauthorizedModule: rootUnauthorizedModule ?? null,
    route,
    slotOverrides:
      opts && opts.interceptSlotKey && opts.interceptPage
        ? {
            [opts.interceptSlotKey]: {
              layoutModules: opts.interceptLayouts || null,
              pageModule: opts.interceptPage,
              params: opts.interceptParams || params,
            },
          }
        : null,
  });
}
