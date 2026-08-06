import { Fragment, createElement, type ComponentType, type ReactNode } from "react";
import { buildClientHookErrorMessage } from "vinext/shims/client-hook-error";
import DefaultGlobalError from "vinext/shims/default-global-error";
import {
  ErrorBoundary,
  GlobalErrorBoundary,
  SerializedErrorBoundary,
  type SerializedBoundaryError,
} from "vinext/shims/error-boundary";
import { LayoutSegmentProvider } from "vinext/shims/layout-segment-context";
import { MetadataHead, ViewportHead } from "vinext/shims/metadata";
import type { NavigationContext } from "vinext/shims/navigation";
import { isNavigationSignalError } from "../utils/navigation-signal.js";
import { stripBasePath } from "../utils/base-path.js";
import {
  buildAppPageSpecialErrorResponse,
  bufferAppPageBinaryStream,
  resolveAppPageSpecialError,
  type AppPageFontPreload,
  type AppPageSpecialError,
} from "./app-page-execution.js";
import { buildRscRedirectFlightStream } from "./app-rsc-redirect-flight.js";
import { stripRscSuffix } from "./app-rsc-cache-busting.js";
import type { AppPageMiddlewareContext } from "./app-page-response.js";
import type { MetadataFileRoute } from "./metadata-routes.js";
import {
  resolveActiveParallelRouteHeadInputs,
  resolveAppPageHead,
  type ActiveParallelRouteHeadInput,
  type ApplyAppPageFileBasedMetadata,
} from "./app-page-head.js";
import {
  resolveHttpAccessFallbackMetadata,
  resolveHttpAccessFallbackViewport,
} from "./app-page-http-access-fallback-metadata.js";
import {
  resolveSlotParamOverrides,
  type AppPageInterceptOptions,
} from "./app-page-element-builder.js";
import { resolveAppPageBranchParams, resolveAppPageSegmentParams } from "./app-page-params.js";
import { SIBLING_PAGE_INTERCEPT_SLOT_KEY } from "./app-rsc-route-matching.js";
import {
  renderAppPageBoundaryResponse,
  resolveAppPageErrorBoundary,
  resolveAppPageHttpAccessBoundaryModule,
  wrapAppPageBoundaryElement,
  type AppPageParams,
} from "./app-page-boundary.js";
import {
  createAppPageFontData,
  createAppPageRscErrorTracker,
  renderAppPageHtmlResponse,
  type AppPageSsrHandler,
} from "./app-page-stream.js";
import { AppElementsWire, type AppElements } from "./app-elements.js";
import {
  createAppPageLayoutEntries,
  createAppPageSourcePage,
  type AppPageRouteWiringRoute,
} from "./app-page-route-wiring.js";
import { NEVER_CACHE_CONTROL } from "./cache-control.js";

// oxlint-disable-next-line @typescript-eslint/no-explicit-any
type AppPageComponent = ComponentType<any>;

// The built-in default global-error component, widened to the loose
// `AppPageComponent` prop shape used throughout the boundary plumbing. Its own
// props (`{ error: { digest? }, reset? }`) are narrower than the boundary's
// `{ error: unknown; reset }` fallback contract, so the cast bridges the
// contravariant mismatch the same way user global-error components do.
const DEFAULT_GLOBAL_ERROR_COMPONENT = DefaultGlobalError as AppPageComponent;
type AppPageModule = Record<string, unknown> & {
  default?: AppPageComponent | null | undefined;
};
type AppPageBoundaryOnError = (
  error: unknown,
  requestInfo: unknown,
  errorContext: unknown,
) => unknown;

type AppPageBoundaryRscPayloadOptions<TModule extends AppPageModule = AppPageModule> = {
  element: ReactNode;
  layoutModules: readonly (TModule | null | undefined)[];
  pathname: string;
  route?: AppPageBoundaryRoute<TModule> | null;
  sourcePageSegments?: readonly string[] | null;
};

type AppPageBoundaryLayoutEntry = {
  id: string;
  treePath: string;
};

export type AppPageBoundaryRoute<TModule extends AppPageModule = AppPageModule> = {
  error?: TModule | null;
  errorPaths?: readonly TModule[] | null;
  errors?: readonly (TModule | null | undefined)[] | null;
  forbidden?: TModule | null;
  forbiddenTreePosition?: number | null;
  forbiddens?: readonly (TModule | null | undefined)[] | null;
  layoutTreePositions?: readonly number[] | null;
  layouts?: readonly (TModule | null | undefined)[];
  notFound?: TModule | null;
  notFounds?: readonly (TModule | null | undefined)[] | null;
  notFoundTreePosition?: number | null;
  params?: AppPageParams;
  pattern?: string;
  routeSegments?: readonly string[];
  slots?: AppPageRouteWiringRoute<TModule>["slots"];
  unauthorized?: TModule | null;
  unauthorizedTreePosition?: number | null;
  unauthorizeds?: readonly (TModule | null | undefined)[] | null;
};

type AppPageBoundaryRenderCommonOptions<TModule extends AppPageModule = AppPageModule> = {
  applyFileBasedMetadata?: ApplyAppPageFileBasedMetadata;
  buildFontLinkHeader: (preloads: readonly AppPageFontPreload[] | null | undefined) => string;
  clearRequestContext: () => void;
  createRscOnErrorHandler: (pathname: string, routePath: string) => AppPageBoundaryOnError;
  getAndClearPendingCookies?: () => string[];
  getFontLinks: () => string[];
  getFontPreloads: () => AppPageFontPreload[];
  getFontStyles: () => string[];
  getNavigationContext: () => NavigationContext | null;
  globalErrorModule?: TModule | null;
  isEdgeRuntime?: boolean;
  isRscRequest: boolean;
  loadSsrHandler: () => Promise<AppPageSsrHandler>;
  makeThenableParams: (params: AppPageParams) => unknown;
  middlewareContext: AppPageMiddlewareContext;
  metadataRoutes: MetadataFileRoute[];
  /**
   * Whether metadata-origin redirects should ride as a 200 streaming response
   * (HTML meta-refresh / RSC flight) rather than a blocking 307. Mirrors the
   * matched-page dispatch decision `shouldServeStreamingMetadata(userAgent,
   * htmlLimitedBots)`: html-limited bots get the blocking 307, so a
   * `generateMetadata()` redirect thrown from a fallback boundary matches the
   * matched-page path instead of always defaulting to streaming. Undefined
   * means "not computed" and is treated as streaming, preserving prior behavior
   * for callers that never hit metadata redirects.
   */
  serveStreamingMetadata?: boolean;
  /** Configured next.config `basePath`, threaded into file-based metadata href emission. */
  basePath?: string;
  /** Configured next.config `trailingSlash`, threaded into canonical URL rendering. */
  trailingSlash?: boolean;
  renderToReadableStream: (
    element: ReactNode | AppElements,
    options: { onError: AppPageBoundaryOnError },
  ) => ReadableStream<Uint8Array>;
  request: Request;
  requestUrl: string;
  resolveChildSegments: (
    routeSegments: readonly string[],
    treePosition: number,
    params: AppPageParams,
  ) => string[];
  rootLayouts: readonly (TModule | null | undefined)[];
  scriptNonce?: string;
  sourcePageSegments?: readonly string[] | null;
};

type RenderAppPageHttpAccessFallbackOptions<TModule extends AppPageModule = AppPageModule> = {
  boundaryComponent?: AppPageComponent | null;
  boundaryModule?: TModule | null;
  intercept?: AppPageInterceptOptions<TModule> | null;
  layoutModules?: readonly (TModule | null | undefined)[] | null;
  matchedParams: AppPageParams;
  rootForbiddenModule?: TModule | null;
  rootNotFoundModule?: TModule | null;
  rootUnauthorizedModule?: TModule | null;
  /** Normalized, basePath-free application pathname used for route matching. */
  routePathname?: string;
  route?: AppPageBoundaryRoute<TModule> | null;
  /**
   * When true, the resolved boundary is rendered without wrapping it in the
   * route's layouts. Used by `global-not-found.tsx`, which provides its own
   * `<html>`/`<body>` and intentionally replaces the root layout.
   * Mirrors Next.js's `createNotFoundLoaderTree` behavior for `hasGlobalNotFound`.
   * @see https://github.com/vercel/next.js/blob/canary/packages/next/src/server/app-render/app-render.tsx#L495-L520
   */
  skipLayoutWrapping?: boolean;
  statusCode: number;
} & AppPageBoundaryRenderCommonOptions<TModule>;

type RenderAppPageErrorBoundaryOptions<TModule extends AppPageModule = AppPageModule> = {
  error: unknown;
  errorOrigin?: "rsc" | "ssr";
  matchedParams?: AppPageParams | null;
  route?: AppPageBoundaryRoute<TModule> | null;
  sanitizeErrorForClient: (error: Error) => Error;
} & AppPageBoundaryRenderCommonOptions<TModule>;

function getDefaultExport<TModule extends AppPageModule>(
  module: TModule | null | undefined,
): AppPageComponent | null {
  return module?.default ?? null;
}

function resolveHttpAccessBoundaryTreePosition<TModule extends AppPageModule>(
  route: AppPageBoundaryRoute<TModule> | null | undefined,
  boundaryModule: TModule | null | undefined,
  statusCode: number,
): number | null {
  if (!route || !boundaryModule) return null;
  const routeBoundary =
    statusCode === 403 ? route.forbidden : statusCode === 401 ? route.unauthorized : route.notFound;
  const layoutBoundaries =
    statusCode === 403
      ? route.forbiddens
      : statusCode === 401
        ? route.unauthorizeds
        : route.notFounds;
  if (boundaryModule === routeBoundary && statusCode === 404) {
    return route.notFoundTreePosition ?? null;
  }
  if (boundaryModule === routeBoundary && statusCode === 403) {
    return route.forbiddenTreePosition ?? null;
  }
  if (boundaryModule === routeBoundary && statusCode === 401) {
    return route.unauthorizedTreePosition ?? null;
  }
  for (let index = (layoutBoundaries?.length ?? 0) - 1; index >= 0; index--) {
    if (layoutBoundaries?.[index] === boundaryModule) {
      return route.layoutTreePositions?.[index] ?? null;
    }
  }
  return null;
}

function wrapRenderedBoundaryElement<TModule extends AppPageModule>(
  options: Pick<
    AppPageBoundaryRenderCommonOptions<TModule>,
    "globalErrorModule" | "isRscRequest" | "makeThenableParams" | "resolveChildSegments"
  > & {
    element: ReactNode;
    includeGlobalErrorBoundary: boolean;
    layoutModules: readonly (TModule | null | undefined)[];
    layoutTreePositions?: readonly number[] | null;
    matchedParams: AppPageParams;
    routeSegments?: readonly string[];
    skipLayoutWrapping?: boolean;
  },
): ReactNode {
  return wrapAppPageBoundaryElement({
    element: options.element,
    getDefaultExport,
    globalErrorComponent: getDefaultExport(options.globalErrorModule),
    includeGlobalErrorBoundary: options.includeGlobalErrorBoundary,
    isRscRequest: options.isRscRequest,
    layoutModules: options.layoutModules,
    layoutTreePositions: options.layoutTreePositions,
    makeThenableParams: options.makeThenableParams,
    matchedParams: options.matchedParams,
    renderErrorBoundary(GlobalErrorComponent, children) {
      // Nest the user's global-error inside an outer boundary whose fallback is
      // the built-in default global-error. If the user's global-error throws
      // while rendering, React unwinds to this outer boundary and renders the
      // minimal built-in fallback instead of crashing the request. Matches
      // Next.js's `RootErrorBoundary errorComponent={DefaultGlobalError}`.
      return createElement(GlobalErrorBoundary, {
        fallback: DEFAULT_GLOBAL_ERROR_COMPONENT,
        // oxlint-disable-next-line react/no-children-prop
        children: createElement(ErrorBoundary, {
          fallback: GlobalErrorComponent,
          // oxlint-disable-next-line react/no-children-prop
          children,
        }),
      });
    },
    renderLayout(LayoutComponent, children, asyncParams) {
      return createElement(LayoutComponent as AppPageComponent, {
        // oxlint-disable-next-line react/no-children-prop
        children,
        params: asyncParams,
      });
    },
    renderLayoutSegmentProvider(segmentMap, children) {
      return createElement(
        // oxlint-disable-next-line @typescript-eslint/no-explicit-any
        LayoutSegmentProvider as ComponentType<any>,
        { segmentMap },
        children,
      );
    },
    resolveChildSegments: options.resolveChildSegments,
    routeSegments: options.routeSegments ?? [],
    skipLayoutWrapping: options.skipLayoutWrapping,
  });
}

function createAppPageBoundaryLayoutEntries<TModule extends AppPageModule>(
  route: AppPageBoundaryRoute<TModule> | null | undefined,
  layoutModules: readonly (TModule | null | undefined)[],
): readonly AppPageBoundaryLayoutEntry[] {
  if (!route || layoutModules.length === 0) return [];

  return createAppPageLayoutEntries({
    errors: route.errors,
    layoutTreePositions: route.layoutTreePositions,
    layouts: layoutModules,
    notFounds: null,
    routeSegments: route.routeSegments,
  });
}

function resolveHttpAccessFallbackHeadRouteSegments<TModule extends AppPageModule>(
  route: AppPageBoundaryRoute<TModule> | null | undefined,
  layoutModules: readonly (TModule | null | undefined)[],
): readonly string[] | undefined {
  if (!route?.routeSegments) {
    return undefined;
  }

  if (!route.layouts || layoutModules.length >= route.layouts.length) {
    return route.routeSegments;
  }

  const lastIncludedLayoutIndex = layoutModules.length - 1;
  if (lastIncludedLayoutIndex < 0) {
    return [];
  }

  const segmentCount = route.layoutTreePositions?.[lastIncludedLayoutIndex] ?? 0;
  return route.routeSegments.slice(0, segmentCount);
}

function resolveHttpAccessFallbackHeadLayoutTreePositions<TModule extends AppPageModule>(
  route: AppPageBoundaryRoute<TModule> | null | undefined,
  layoutModules: readonly (TModule | null | undefined)[],
): readonly number[] | null | undefined {
  if (!route?.layouts || layoutModules.length >= route.layouts.length) {
    return route?.layoutTreePositions;
  }

  return route.layoutTreePositions?.slice(0, layoutModules.length);
}

function createAppPageBoundaryRscPayload<TModule extends AppPageModule>(
  options: AppPageBoundaryRscPayloadOptions<TModule>,
): AppElements {
  const routeId = AppElementsWire.encodeRouteId(options.pathname, null);
  const layoutEntries = createAppPageBoundaryLayoutEntries(options.route, options.layoutModules);
  const sourcePageSegments = options.sourcePageSegments ?? options.route?.routeSegments;

  return {
    ...AppElementsWire.createMetadataEntries({
      interceptionContext: null,
      layoutIds: layoutEntries.map((entry) => entry.id),
      rootLayoutTreePath: layoutEntries[0]?.treePath ?? null,
      routeId,
      sourcePage: sourcePageSegments ? createAppPageSourcePage(sourcePageSegments) : null,
    }),
    [routeId]: options.element,
  };
}

// Terminal special-error responder for HTTP-access fallback rendering — a
// redirect/not-found/forbidden/unauthorized thrown *while* rendering a
// not-found/forbidden/unauthorized boundary, whether that boundary comes from a
// route miss or a matched route's own signal. It deliberately omits
// `renderFallbackPage`, which scopes the guarantee here to redirects:
//   - redirect() → 307 (document) or a 200 flight payload (RSC), fully handled.
//   - notFound()/forbidden()/unauthorized() → the shared builder falls through
//     to a plain status-text response. That is intentional: we are already
//     inside boundary rendering, so re-entering fallback rendering would recurse
//     on the same boundary. The matched layout/page paths pass a
//     `renderFallbackPage` because they can climb to a *parent* boundary; the
//     root boundary has none.
function renderBoundarySpecialErrorResponse<TModule extends AppPageModule>(
  options: AppPageBoundaryRenderCommonOptions<TModule>,
  specialError: AppPageSpecialError,
): Promise<Response> {
  return buildAppPageSpecialErrorResponse({
    basePath: options.basePath,
    buildRscRedirectFlightStream: (rscOptions) =>
      buildRscRedirectFlightStream({
        renderToReadableStream: options.renderToReadableStream,
        digest: rscOptions.digest,
      }),
    clearRequestContext: options.clearRequestContext,
    getAndClearPendingCookies: options.getAndClearPendingCookies,
    isEdgeRuntime: options.isEdgeRuntime,
    isRscRequest: options.isRscRequest,
    middlewareContext: options.middlewareContext,
    // Thread the streaming-metadata decision so a generateMetadata() redirect
    // from this fallback boundary honors html-limited bots (blocking 307),
    // matching the matched-page dispatch path. Undefined stays streaming.
    serveStreamingMetadata: options.serveStreamingMetadata,
    request: options.request,
    specialError,
  });
}

async function renderAppPageBoundaryElementResponse<TModule extends AppPageModule>(
  options: AppPageBoundaryRenderCommonOptions<TModule> & {
    element: ReactNode;
    handleSpecialErrors?: boolean;
    initialDevServerError?: unknown;
    layoutModules: readonly (TModule | null | undefined)[];
    navigationParams?: AppPageParams;
    route?: AppPageBoundaryRoute<TModule> | null;
    routePattern?: string;
    status: number;
  },
): Promise<Response> {
  const requestUrl = new URL(options.requestUrl);
  const pathname = requestUrl.pathname;
  const payload = createAppPageBoundaryRscPayload({
    element: options.element,
    layoutModules: options.layoutModules,
    pathname,
    route: options.route,
    sourcePageSegments: options.sourcePageSegments,
  });

  const baseRscOnErrorHandler = options.createRscOnErrorHandler(
    pathname,
    options.routePattern ?? pathname,
  );
  const rscErrorTracker = createAppPageRscErrorTracker(baseRscOnErrorHandler);
  const resolveCapturedSpecialError = (error?: unknown) =>
    resolveAppPageSpecialError(error) ??
    resolveAppPageSpecialError(rscErrorTracker.getCapturedSpecialError());
  const renderSpecialErrorResponse = (specialError: AppPageSpecialError) =>
    renderBoundarySpecialErrorResponse(options, specialError);
  const handleSpecialErrors = options.handleSpecialErrors === true;

  let response: Response;
  try {
    response = await renderAppPageBoundaryResponse({
      async createHtmlResponse(rscStream, responseStatus) {
        const fontData = createAppPageFontData({
          getLinks: options.getFontLinks,
          getPreloads: options.getFontPreloads,
          getStyles: options.getFontStyles,
        });
        const ssrHandler = await options.loadSsrHandler();
        return renderAppPageHtmlResponse({
          clearRequestContext: options.clearRequestContext,
          fontData,
          fontLinkHeader: options.buildFontLinkHeader(fontData.preloads),
          isEdgeRuntime: options.isEdgeRuntime,
          middlewareHeaders: options.middlewareContext.headers,
          navigationContext: options.getNavigationContext() ?? {
            pathname,
            searchParams: requestUrl.searchParams,
            params: options.navigationParams ?? options.route?.params ?? {},
          },
          rscStream,
          scriptNonce: options.scriptNonce,
          ssrHandler,
          status: responseStatus,
          initialDevServerError: options.initialDevServerError,
        });
      },
      createRscOnErrorHandler() {
        return rscErrorTracker.onRenderError;
      },
      element: payload,
      isEdgeRuntime: options.isEdgeRuntime,
      isRscRequest: options.isRscRequest,
      middlewareHeaders: options.middlewareContext.headers,
      renderToReadableStream: options.renderToReadableStream,
      status: options.status,
    });
  } catch (error) {
    const specialError = handleSpecialErrors ? resolveCapturedSpecialError(error) : null;
    if (specialError !== null) {
      return renderSpecialErrorResponse(specialError);
    }
    throw error;
  }

  if (!handleSpecialErrors) {
    return response;
  }

  // RSC responses are returned without being consumed here, so a
  // redirect()/notFound() thrown by an *async* server component — e.g. a root
  // layout that `await headers()` before redirect() — has not yet surfaced
  // through React's onError when the capture check below runs. Drain a tee'd
  // copy to force the render to settle so the special error is captured before
  // we commit the raw boundary response, then hand the buffered copy back as
  // the body. The document path already consumes the stream in
  // createHtmlResponse, so this only applies to RSC.
  //
  // This applies to every HTTP-access fallback render, not just route misses:
  // a matched route's notFound()/forbidden()/unauthorized() renders its
  // boundary through this same path, and a layout there can async-redirect too.
  // These are terminal error documents (a not-found/forbidden UI), so buffering
  // one before responding is an acceptable cost for correct redirect handling —
  // and correctness must not depend on whether the boundary happens to be a
  // route miss. Mirrors app-page-render.ts's pre-flush special-error capture.
  if (options.isRscRequest && response.body) {
    const bufferedStream = await bufferAppPageBinaryStream(response.body);
    response = new Response(bufferedStream, {
      status: response.status,
      headers: response.headers,
    });
  }

  const specialError = resolveCapturedSpecialError();
  if (!specialError) {
    return response;
  }

  if (response.body) {
    try {
      await response.body.cancel();
    } catch {
      // Best-effort cleanup. The response is being replaced by a terminal
      // redirect/http-access response, so a cancellation race cannot affect
      // the observable request result.
    }
  }

  return renderSpecialErrorResponse(specialError);
}

export async function renderAppPageHttpAccessFallback<TModule extends AppPageModule>(
  options: RenderAppPageHttpAccessFallbackOptions<TModule>,
): Promise<Response | null> {
  const resolvedBoundaryModule = resolveAppPageHttpAccessBoundaryModule({
    rootForbiddenModule: options.rootForbiddenModule,
    rootNotFoundModule: options.rootNotFoundModule,
    rootUnauthorizedModule: options.rootUnauthorizedModule,
    routeForbiddenModule: options.route?.forbidden,
    routeNotFoundModule: options.route?.notFound,
    routeUnauthorizedModule: options.route?.unauthorized,
    statusCode: options.statusCode,
  });
  const boundaryModule = options.boundaryModule ?? resolvedBoundaryModule;
  // `boundaryModule` already resolves both the explicit-module and resolved
  // (status-derived) cases, so `getDefaultExport(boundaryModule)` is the single
  // source of truth here. A previous `resolveAppPageHttpAccessBoundaryComponent`
  // fallback was redundant — it re-ran the same `resolveAppPageHttpAccessBoundaryModule`
  // resolution and produced the same component for the resolved-module path.
  const boundaryComponent = options.boundaryComponent ?? getDefaultExport(boundaryModule);
  if (!boundaryComponent) {
    return null;
  }

  const layoutModules = options.layoutModules ?? options.route?.layouts ?? options.rootLayouts;
  const pathname = new URL(options.requestUrl).pathname;
  const routePathname =
    options.routePathname ?? stripRscSuffix(stripBasePath(pathname, options.basePath ?? ""));
  const routeSegments = resolveHttpAccessFallbackHeadRouteSegments(options.route, layoutModules);
  const fallbackRouteSegments = routeSegments ?? [];
  let head: Pick<Awaited<ReturnType<typeof resolveAppPageHead>>, "metadata" | "viewport">;
  try {
    const useHttpAccessHeadPlan = [401, 403, 404].includes(options.statusCode);
    if (useHttpAccessHeadPlan) {
      const boundaryTreePosition = resolveHttpAccessBoundaryTreePosition(
        options.route,
        boundaryModule,
        options.statusCode,
      );
      const boundaryParams =
        boundaryTreePosition == null
          ? {}
          : resolveAppPageSegmentParams(
              fallbackRouteSegments,
              boundaryTreePosition,
              options.matchedParams,
            );
      const intercept = options.intercept;
      const isSiblingIntercept =
        intercept?.interceptSlotKey === SIBLING_PAGE_INTERCEPT_SLOT_KEY &&
        intercept.interceptPage != null;
      const effectiveParams = isSiblingIntercept
        ? (intercept.interceptParams ?? options.matchedParams)
        : options.matchedParams;
      const slotParams = resolveSlotParamOverrides(
        { slots: options.route?.slots ?? null },
        routePathname,
      );
      const parallelBranches = resolveActiveParallelRouteHeadInputs({
        interceptBranchSegments: intercept?.interceptBranchSegments ?? null,
        interceptLayouts: intercept?.interceptLayouts ?? null,
        interceptLayoutSegments: intercept?.interceptLayoutSegments ?? null,
        interceptNotFoundBranchSegments: intercept?.interceptNotFoundBranchSegments ?? null,
        interceptNotFound: intercept?.interceptNotFound ?? null,
        interceptNotFoundTreePosition: intercept?.interceptNotFoundTreePosition ?? null,
        interceptPage: intercept?.interceptPage ?? null,
        interceptParams: intercept?.interceptParams ?? null,
        interceptSlotKey: intercept?.interceptSlotKey ?? null,
        interceptSourcePageSegments: intercept?.interceptSourcePageSegments ?? null,
        layoutTreePositions: options.route?.layoutTreePositions,
        params: options.matchedParams,
        routeSegments: fallbackRouteSegments,
        slotParams,
        slots: options.route?.slots ?? null,
      });
      const primaryParallelBranch: ActiveParallelRouteHeadInput<TModule> | null = isSiblingIntercept
        ? {
            head: {
              layoutModules: intercept?.interceptLayouts ?? [],
              layoutParams: (intercept?.interceptLayoutSegments ?? []).map((segments) =>
                resolveAppPageBranchParams(
                  intercept?.interceptBranchSegments ?? segments,
                  segments.length,
                  effectiveParams,
                  segments,
                ),
              ),
              pageModule: intercept?.interceptPage ?? null,
              params: effectiveParams,
              routeSegments: intercept?.interceptSourcePageSegments ?? fallbackRouteSegments,
            },
            ...(intercept?.interceptNotFound
              ? {
                  notFoundModule: intercept.interceptNotFound,
                  notFoundParams: resolveAppPageBranchParams(
                    intercept.interceptNotFoundBranchSegments ??
                      intercept.interceptBranchSegments ??
                      fallbackRouteSegments,
                    intercept.interceptNotFoundTreePosition ?? 0,
                    effectiveParams,
                  ),
                }
              : {}),
            ownerTreePosition: fallbackRouteSegments.length,
          }
        : null;
      const fallbackHeadOptions = {
        boundaryModule,
        boundaryParams,
        branchNotFoundConventions: options.statusCode === 404,
        layoutModules,
        layoutTreePositions: resolveHttpAccessFallbackHeadLayoutTreePositions(
          options.route,
          layoutModules,
        ),
        parallelBranches,
        params: options.matchedParams,
        primaryParallelBranch,
        routeSegments,
      };
      const [metadata, viewport] = await Promise.all([
        resolveHttpAccessFallbackMetadata({
          applyFileBasedMetadata: options.applyFileBasedMetadata,
          basePath: options.basePath ?? "",
          ...fallbackHeadOptions,
          metadataRoutes: options.metadataRoutes,
          routePath: options.route?.pattern ?? pathname,
        }),
        resolveHttpAccessFallbackViewport(fallbackHeadOptions),
      ]);
      head = { metadata, viewport };
    } else {
      head = await resolveAppPageHead({
        applyFileBasedMetadata: options.applyFileBasedMetadata,
        basePath: options.basePath ?? "",
        layoutModules,
        layoutTreePositions: resolveHttpAccessFallbackHeadLayoutTreePositions(
          options.route,
          layoutModules,
        ),
        metadataRoutes: options.metadataRoutes,
        pageModule: boundaryModule,
        params: options.matchedParams,
        routePath: options.route?.pattern ?? pathname,
        routeSegments,
      });
    }
  } catch (error) {
    const specialError = resolveAppPageSpecialError(error);
    if (specialError) {
      return renderBoundarySpecialErrorResponse(options, specialError);
    }
    throw error;
  }
  const { metadata, viewport } = head;

  const headElements: ReactNode[] = [
    createElement("meta", { charSet: "utf-8", key: "charset" }),
    createElement("meta", { key: "robots", name: "robots", content: "noindex" }),
  ];
  if (metadata) {
    headElements.push(
      createElement(MetadataHead, {
        key: "metadata",
        metadata,
        pathname,
        trailingSlash: options.trailingSlash,
      }),
    );
  }
  headElements.push(createElement(ViewportHead, { key: "viewport", viewport }));

  const skipLayoutWrapping = options.skipLayoutWrapping ?? false;
  const element = wrapRenderedBoundaryElement({
    element: createElement(Fragment, null, ...headElements, createElement(boundaryComponent)),
    globalErrorModule: options.globalErrorModule,
    includeGlobalErrorBoundary: true,
    isRscRequest: options.isRscRequest,
    layoutModules,
    layoutTreePositions: options.route?.layoutTreePositions,
    makeThenableParams: options.makeThenableParams,
    matchedParams: options.matchedParams,
    resolveChildSegments: options.resolveChildSegments,
    routeSegments: options.route?.routeSegments,
    skipLayoutWrapping,
  });

  return renderAppPageBoundaryElementResponse({
    ...options,
    // When global-not-found owns the document, no layouts should contribute to
    // the RSC payload's layout entries either — otherwise the SSR pipeline
    // would expect a root-layout tree path that doesn't exist in the markup.
    element,
    handleSpecialErrors: true,
    layoutModules: skipLayoutWrapping ? [] : layoutModules,
    navigationParams: options.matchedParams,
    route: skipLayoutWrapping ? null : options.route,
    routePattern: options.route?.pattern,
    status: options.statusCode,
  });
}

export async function renderAppPageErrorBoundary<TModule extends AppPageModule>(
  options: RenderAppPageErrorBoundaryOptions<TModule>,
): Promise<Response | null> {
  const errorBoundary = resolveAppPageErrorBoundary({
    getDefaultExport,
    errorModules: options.route?.errorPaths,
    globalErrorModule: options.globalErrorModule,
    layoutErrorModules: options.route?.errors,
    pageErrorModule: options.route?.error,
  });
  if (!errorBoundary.component) {
    return null;
  }

  const rawError =
    options.error instanceof Error ? options.error : new Error(String(options.error));
  rewriteClientHookError(rawError);
  const errorObject =
    options.errorOrigin === "ssr" ? rawError : options.sanitizeErrorForClient(rawError);
  const matchedParams = options.matchedParams ?? options.route?.params ?? {};
  const layoutModules = options.route?.layouts ?? options.rootLayouts;
  const pathname = new URL(options.requestUrl).pathname;

  const headElements: ReactNode[] = [createElement("meta", { charSet: "utf-8", key: "charset" })];
  if (!errorBoundary.isGlobalError) {
    try {
      const { metadata, viewport } = await resolveAppPageHead({
        applyFileBasedMetadata: options.applyFileBasedMetadata,
        basePath: options.basePath ?? "",
        fallbackOnFileMetadataError: true,
        layoutModules,
        layoutTreePositions: options.route?.layoutTreePositions,
        metadataRoutes: options.metadataRoutes,
        params: matchedParams,
        routePath: options.route?.pattern ?? pathname,
        routeSegments: options.route?.routeSegments,
      });
      if (metadata) {
        headElements.push(
          createElement(MetadataHead, {
            key: "metadata",
            metadata,
            pathname,
            trailingSlash: options.trailingSlash,
          }),
        );
      }
      headElements.push(createElement(ViewportHead, { key: "viewport", viewport }));
    } catch (error) {
      console.error(
        `[vinext] App page error boundary head resolution failed for ${options.route?.pattern ?? pathname}:`,
        error,
      );
    }
  }

  // Build the boundary element for a given component. When the resolved
  // boundary IS the global-error (no local error.tsx caught the error), it
  // renders directly without a surrounding ErrorBoundary; nest it inside
  // GlobalErrorBoundary so that if the user's global-error.tsx itself throws,
  // React unwinds (on the client) to the built-in default global-error fallback
  // instead of leaving the user with a broken boundary. Local error.tsx
  // boundaries already sit under the global-error boundary added by
  // wrapAppPageBoundaryElement (includeGlobalErrorBoundary), so they don't need
  // this extra wrapping. Mirrors Next.js's outer
  // `RootErrorBoundary errorComponent={DefaultGlobalError}`.
  const buildElement = (BoundaryComponent: AppPageComponent): ReactNode => {
    const serializedError = {
      digest: "digest" in errorObject ? String(errorObject.digest) : undefined,
      message: errorObject.message,
      name: errorObject.name,
      stack: process.env.NODE_ENV !== "production" ? errorObject.stack : undefined,
    } satisfies SerializedBoundaryError;
    const boundaryElement =
      errorBoundary.isGlobalError && BoundaryComponent !== DEFAULT_GLOBAL_ERROR_COMPONENT
        ? createElement(SerializedErrorBoundary, {
            error: serializedError,
            fallback: BoundaryComponent,
          })
        : createElement(BoundaryComponent, { error: errorObject });
    return wrapRenderedBoundaryElement({
      element: createElement(
        Fragment,
        null,
        ...headElements,
        errorBoundary.isGlobalError
          ? createElement(GlobalErrorBoundary, {
              fallback: DEFAULT_GLOBAL_ERROR_COMPONENT,
              // oxlint-disable-next-line react/no-children-prop
              children: boundaryElement,
            })
          : boundaryElement,
      ),
      globalErrorModule: options.globalErrorModule,
      includeGlobalErrorBoundary: !errorBoundary.isGlobalError,
      isRscRequest: options.isRscRequest,
      layoutModules,
      layoutTreePositions: options.route?.layoutTreePositions,
      makeThenableParams: options.makeThenableParams,
      matchedParams,
      resolveChildSegments: options.resolveChildSegments,
      routeSegments: options.route?.routeSegments,
      skipLayoutWrapping: errorBoundary.isGlobalError,
    });
  };

  const renderWith = async (BoundaryComponent: AppPageComponent): Promise<Response> => {
    const response = await renderAppPageBoundaryElementResponse({
      ...options,
      element: buildElement(BoundaryComponent),
      initialDevServerError: rawError,
      layoutModules,
      navigationParams: matchedParams,
      route: options.route,
      routePattern: options.route?.pattern,
      status: errorBoundary.isGlobalError ? 500 : 200,
    });
    if (errorBoundary.isGlobalError) {
      response.headers.set("Cache-Control", NEVER_CACHE_CONTROL);
      response.headers.delete("CDN-Cache-Control");
      response.headers.delete("Cloudflare-CDN-Cache-Control");
      response.headers.delete("Cache-Tag");
    }
    return response;
  };

  try {
    return await renderWith(errorBoundary.component);
  } catch (renderError) {
    // The user's global-error.tsx threw while rendering. React's SSR shell
    // render rejects on a shell-level throw even though an error boundary is
    // present (the boundary only enables client recovery). Re-render with the
    // built-in default global-error so the request still produces a usable
    // document instead of a raw 500. Only the global-error boundary owns the
    // whole document, so this server-side fallback is scoped to it; other
    // boundaries propagate as before.
    //
    // Navigation/HTTP-access signals (redirect(), notFound(), forbidden(),
    // unauthorized()) thrown from within global-error are re-thrown so they
    // propagate rather than being swallowed into a built-in 200 (degrading a
    // redirect() to a misleading success page). This keeps the fallback scoped
    // to genuine render failures instead of catching every error from
    // `renderWith`. (In this position a re-thrown signal reaches the top-level
    // handler, the same as before this change — see app-page-request.ts.)
    if (
      errorBoundary.isGlobalError &&
      !isNavigationSignalError(renderError) &&
      !resolveAppPageSpecialError(renderError)
    ) {
      console.error(
        `[vinext] global-error.tsx threw while rendering for ${options.route?.pattern ?? pathname}; falling back to the built-in default global-error:`,
        renderError,
      );
      return renderWith(DEFAULT_GLOBAL_ERROR_COMPONENT);
    }
    throw renderError;
  }
}

// React client-only hooks that are absent from the `react-server` export
// condition. When called in a Server Component they produce a TypeError like
// "useState is not a function". Rewrite into an actionable message matching
// the format used by the next/navigation shims (see client-hook-error.ts).
const _clientHookPattern =
  /\b(useState|useEffect|useReducer|useRef|useContext|useLayoutEffect|useInsertionEffect|useSyncExternalStore|useTransition|useImperativeHandle|useDeferredValue|useActionState|useOptimistic|useEffectEvent)\b.*is not a function/;

function rewriteClientHookError(error: Error): void {
  const match = error.message.match(_clientHookPattern);
  if (match) {
    error.message = buildClientHookErrorMessage(`${match[1]}()`);
  }
}
