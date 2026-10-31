import { Fragment, Suspense, createElement, type ComponentType, type ReactNode } from "react";
import { buildClientHookErrorMessage } from "vinext/shims/client-hook-error";
import DefaultGlobalError from "vinext/shims/default-global-error";
import {
  ErrorBoundary,
  GlobalErrorBoundary,
  SerializedErrorBoundary,
  type SerializedBoundaryError,
} from "vinext/shims/error-boundary";
import { LayoutSegmentProvider } from "vinext/shims/layout-segment-context";
import { withUseCacheLayoutMarker } from "vinext/shims/internal/app-page-props-cache-key";
import { MetadataHead, ViewportHead, type Metadata, type Viewport } from "vinext/shims/metadata";
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
import { createArtifactCompatibilityEnvelope } from "./artifact-compatibility.js";
import { stripRscSuffix } from "./app-rsc-cache-busting.js";
import {
  isRenderDynamicLatched,
  isStaticGenerationAccessError,
} from "vinext/shims/internal/headers-state";
import { createAppPageMetadataSearchParamsObserver } from "./app-page-search-params-observation.js";
import type { AppPageMiddlewareContext } from "./app-page-response.js";
import type { MetadataFileRoute } from "./metadata-routes.js";
import {
  hasAppPageDynamicMetadata,
  prepareAppPageHead,
  resolveActiveParallelRouteHeadInputs,
  resolveInterceptLayoutsBesidePage,
  slotInterceptKeepsSourceHead,
  resolveAppPageHead,
  type ActiveParallelRouteHeadInput,
  type AppPageFallbackRouteHead,
  type AppPagePreparedRouteHead,
  type ApplyAppPageFileBasedMetadata,
} from "./app-page-head.js";
import {
  createRouteNotFoundHeadPlanOptions,
  recoverAppPageRouteHead,
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
  resolveAppPageLayoutErrorBoundary,
  wrapAppPageBoundaryElement,
  type AppPageParams,
} from "./app-page-boundary.js";
import {
  createAppPageFontData,
  createAppPageRscErrorTracker,
  createAppPageSsrErrorHandler,
  renderAppPageHtmlResponse,
  type AppPageSsrHandler,
} from "./app-page-stream.js";
import { AppElementsWire, type AppElements } from "./app-elements.js";
import {
  createAppPageLayoutEntries,
  createAppPageRouteBodyMetadata,
  createAppPageSourcePage,
  type AppPageRouteWiringRoute,
} from "./app-page-route-wiring.js";
import { applyCdnResponseHeaders, NEVER_CACHE_CONTROL } from "./cache-control.js";
import { copyLinkHeaderProvenance } from "./app-response-header-provenance.js";
import type { AppRenderErrorContextOverrides } from "./app-rsc-error-handler.js";

// oxlint-disable-next-line @typescript-eslint/no-explicit-any
type AppPageComponent = ComponentType<any>;

// The route's generated metadata, streamed into a fallback document's body.
// The promise already settled its own signals and errors; a `dynamic =
// "error"` access error fails the whole response instead (see
// `failOnLateAccessError`).
async function AppPageBoundaryStreamedMetadata(props: {
  metadata: Promise<Metadata | null>;
  pathname: string;
  scriptNonce?: string;
  trailingSlash?: boolean;
}): Promise<ReactNode> {
  return createAppPageRouteBodyMetadata(
    await props.metadata,
    props.pathname,
    "body",
    props.trailingSlash,
    props.scriptNonce,
  );
}
AppPageBoundaryStreamedMetadata.displayName = "Vinext.StreamingMetadata";

/** Holds the response open until a head it doesn't render settles, as Next.js streams it. */
async function AppPageBoundarySettledHead(props: { head: Promise<unknown> }): Promise<null> {
  await props.head;
  return null;
}
AppPageBoundarySettledHead.displayName = "Vinext.ErrorShellMetadata";

/**
 * Fail a fallback document once its body has streamed if a head it streamed
 * behind Suspense hit a `dynamic = "error"` access error. Inside a Suspense
 * boundary, React would only report it and finish the document, so the 404
 * could be served, and stored, where Next.js fails the render. An errored body
 * reaches the client truncated and is never written to the cache.
 */
function failOnLateAccessError(
  response: Response,
  accessErrors: readonly Promise<Error | null>[],
): Response {
  if (accessErrors.length === 0 || !response.body) return response;
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      async flush() {
        for (const accessError of await Promise.all(accessErrors)) {
          if (accessError) throw accessError;
        }
      },
    }),
  );
  const wrapped = new Response(body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
  // The Headers object is copied, so the renderer's Link provenance, which
  // config-header finalization and ISR read, must be carried over.
  copyLinkHeaderProvenance(response.headers, wrapped.headers);
  return wrapped;
}

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
  errorTreePositions?: readonly number[] | null;
  errors?: readonly (TModule | null | undefined)[] | null;
  forbidden?: TModule | null;
  forbiddenTreePosition?: number | null;
  forbiddens?: readonly (TModule | null | undefined)[] | null;
  layoutTreePositions?: readonly number[] | null;
  layouts?: readonly (TModule | null | undefined)[];
  notFound?: TModule | null;
  notFounds?: readonly (TModule | null | undefined)[] | null;
  notFoundTreePosition?: number | null;
  page?: TModule | null;
  params?: AppPageParams;
  pattern?: string;
  routeSegments?: readonly string[];
  childrenSlot?: AppPageRouteWiringRoute<TModule>["childrenSlot"];
  segmentForbiddens?: readonly (TModule | null | undefined)[] | null;
  segmentForbiddenTreePositions?: readonly number[] | null;
  segmentNotFounds?: readonly (TModule | null | undefined)[] | null;
  segmentNotFoundTreePositions?: readonly number[] | null;
  segmentUnauthorizeds?: readonly (TModule | null | undefined)[] | null;
  segmentUnauthorizedTreePositions?: readonly number[] | null;
  slots?: AppPageRouteWiringRoute<TModule>["slots"];
  unauthorized?: TModule | null;
  unauthorizedTreePosition?: number | null;
  unauthorizeds?: readonly (TModule | null | undefined)[] | null;
};

type AppPageBoundaryRenderCommonOptions<TModule extends AppPageModule = AppPageModule> = {
  applyFileBasedMetadata?: ApplyAppPageFileBasedMetadata;
  buildFontLinkHeader: (preloads: readonly AppPageFontPreload[] | null | undefined) => string;
  clearRequestContext: () => void;
  createRscOnErrorHandler: (
    pathname: string,
    routePath: string,
    overrides?: AppRenderErrorContextOverrides,
  ) => AppPageBoundaryOnError;
  getAndClearPendingCookies?: () => string[];
  getFontLinks: () => string[];
  getFontPreloads: () => AppPageFontPreload[];
  getFontStyles: () => string[];
  getNavigationContext: () => NavigationContext | null;
  globalErrorModule?: TModule | null;
  /**
   * The document may be stored under a query-free key, so its SSR
   * `useSearchParams()` waits as a cache candidate's does.
   */
  isCacheCandidate?: boolean;
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
  /** Boundary whose metadata the head uses, when not the rendered boundary. */
  headBoundaryModule?: TModule | null;
  /** Layouts whose metadata the head uses, when more than render around the boundary. */
  headLayoutModules?: readonly (TModule | null | undefined)[] | null;
  intercept?: AppPageInterceptOptions<TModule> | null;
  layoutModules?: readonly (TModule | null | undefined)[] | null;
  matchedParams: AppPageParams;
  rootForbiddenModule?: TModule | null;
  rootNotFoundModule?: TModule | null;
  rootUnauthorizedModule?: TModule | null;
  /**
   * The matched route's render threw the signal, so the document keeps the
   * route's own head rather than the boundary convention's.
   */
  routeHead?: AppPageFallbackRouteHead | null;
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
  /** The index of the route layout whose own component threw `error`, if one did. */
  throwingLayoutIndex?: number;
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
  const segmentBoundaries =
    statusCode === 403
      ? route.segmentForbiddens
      : statusCode === 401
        ? route.segmentUnauthorizeds
        : route.segmentNotFounds;
  const segmentIndex = segmentBoundaries?.lastIndexOf(boundaryModule) ?? -1;
  if (segmentIndex !== -1) {
    const segmentTreePositions =
      statusCode === 403
        ? route.segmentForbiddenTreePositions
        : statusCode === 401
          ? route.segmentUnauthorizedTreePositions
          : route.segmentNotFoundTreePositions;
    return segmentTreePositions?.[segmentIndex] ?? null;
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
      return createElement(
        LayoutComponent as AppPageComponent,
        withUseCacheLayoutMarker(LayoutComponent, {
          // oxlint-disable-next-line react/no-children-prop
          children,
          params: asyncParams,
        }),
      );
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

  const rootLayoutTreePath = layoutEntries[0]?.treePath ?? null;

  return {
    ...AppElementsWire.createMetadataEntries({
      interceptionContext: null,
      layoutIds: layoutEntries.map((entry) => entry.id),
      rootLayoutTreePath,
      routeId,
      sourcePage: sourcePageSegments ? createAppPageSourcePage(sourcePageSegments) : null,
    }),
    // Like Next.js' build ID in every initial RSC payload, so a static export
    // 404 page can compare later payloads against its own deployment.
    [AppElementsWire.keys.artifactCompatibility]: createArtifactCompatibilityEnvelope({
      deploymentVersion: process.env.__VINEXT_BUILD_ID ?? null,
      rootBoundaryId: rootLayoutTreePath,
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
    mirrorNextFlight?: boolean;
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
        const onSsrError = options.createRscOnErrorHandler(
          pathname,
          options.routePattern ?? pathname,
          { renderSource: "server-rendering" },
        );
        return renderAppPageHtmlResponse({
          clearRequestContext: options.clearRequestContext,
          fontData,
          fontLinkHeader: options.buildFontLinkHeader(fontData.preloads),
          isCacheCandidate: options.isCacheCandidate,
          isEdgeRuntime: options.isEdgeRuntime,
          middlewareHeaders: options.middlewareContext.headers,
          // A boundary without a route shows the root layouts, or global-not-found.
          preloadRoutePattern: options.route ? options.route.pattern : null,
          navigationContext: options.getNavigationContext() ?? {
            pathname,
            searchParams: requestUrl.searchParams,
            params: options.navigationParams ?? options.route?.params ?? {},
          },
          mirrorNextFlight: options.mirrorNextFlight,
          rscStream,
          scriptNonce: options.scriptNonce,
          ssrHandler,
          status: responseStatus,
          initialDevServerError: options.initialDevServerError,
          onSsrError: createAppPageSsrErrorHandler(onSsrError, rscErrorTracker.isCapturedError),
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
  const headBoundaryModule = options.headBoundaryModule ?? boundaryModule;
  const headLayoutModules = options.headLayoutModules ?? layoutModules;
  const routeSegments = resolveHttpAccessFallbackHeadRouteSegments(
    options.route,
    headLayoutModules,
  );
  const fallbackRouteSegments = routeSegments ?? [];
  // A null viewport is a failed branch, which renders no viewport tags.
  let head: { metadata: Metadata | null; viewport: Viewport | null };
  let streamedRouteMetadata: Promise<Metadata | null> | null = null;
  let streamedConventionHead: Promise<unknown> | null = null;
  const lateAccessErrors: Promise<Error | null>[] = [];
  try {
    const useHttpAccessHeadPlan = [401, 403, 404].includes(options.statusCode);
    if (useHttpAccessHeadPlan) {
      const boundaryTreePosition = resolveHttpAccessBoundaryTreePosition(
        options.route,
        headBoundaryModule,
        options.statusCode,
      );
      // A boundary in a segment without a layout can sit below the last
      // rendered layout, so its params and segments come from the full route.
      const boundaryRouteSegments = (options.route?.routeSegments ?? fallbackRouteSegments).slice(
        0,
        boundaryTreePosition ?? 0,
      );
      const boundaryParams =
        boundaryTreePosition == null
          ? {}
          : resolveAppPageSegmentParams(
              boundaryRouteSegments,
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
      // A sibling intercept replaces `children`, so its page heads the route.
      const resolvePrimaryParallelBranch = (
        segments: readonly string[],
      ): ActiveParallelRouteHeadInput<TModule> | null =>
        isSiblingIntercept
          ? {
              head: {
                layoutModules: intercept?.interceptLayouts ?? [],
                layoutParams: (intercept?.interceptLayoutSegments ?? []).map((layoutSegments) =>
                  resolveAppPageBranchParams(
                    intercept?.interceptBranchSegments ?? layoutSegments,
                    layoutSegments.length,
                    effectiveParams,
                    layoutSegments,
                  ),
                ),
                layoutsBesidePage: resolveInterceptLayoutsBesidePage(
                  intercept?.interceptLayoutSegments,
                  intercept?.interceptBranchSegments,
                ),
                pageModule: intercept?.interceptPage ?? null,
                params: effectiveParams,
                routeSegments: intercept?.interceptSourcePageSegments ?? segments,
              },
              ...(intercept?.interceptNotFound
                ? {
                    notFoundModule: intercept.interceptNotFound,
                    notFoundModuleRouteSegments: (
                      intercept.interceptNotFoundBranchSegments ??
                      intercept.interceptSourcePageSegments ??
                      segments
                    ).slice(0, intercept.interceptNotFoundTreePosition ?? 0),
                    notFoundParams: resolveAppPageBranchParams(
                      intercept.interceptNotFoundBranchSegments ??
                        intercept.interceptBranchSegments ??
                        segments,
                      intercept.interceptNotFoundTreePosition ?? 0,
                      effectiveParams,
                    ),
                  }
                : {}),
              ownerTreePosition: segments.length,
            }
          : null;
      const primaryParallelBranch = resolvePrimaryParallelBranch(fallbackRouteSegments);
      const fallbackHeadOptions = {
        boundaryModule: headBoundaryModule,
        boundaryParams,
        boundaryRouteSegments,
        branchNotFoundConventions: options.statusCode === 404,
        errorConvention:
          options.statusCode === 403
            ? ("forbidden" as const)
            : options.statusCode === 401
              ? ("unauthorized" as const)
              : ("not-found" as const),
        layoutModules: headLayoutModules,
        layoutTreePositions: resolveHttpAccessFallbackHeadLayoutTreePositions(
          options.route,
          headLayoutModules,
        ),
        parallelBranches,
        params: options.matchedParams,
        primaryParallelBranch,
        routeSegments,
      };
      // Next.js's document error shell renders the convention's head with no
      // outlet, so its metadata and viewport trees drop any error, a redirect()
      // included: Next.js 16.2.7 still answers 404 there. A `dynamic = "error"`
      // access error still fails the render, as it fails Next.js's.
      // A failed branch renders null there, so a failed viewport has no tags,
      // not the defaults.
      // https://github.com/vercel/next.js/blob/canary/packages/next/src/lib/metadata/metadata.tsx (createMetadataComponents)
      const startConventionHead = ({ errorShell = false } = {}) => {
        const settle = <T>(branch: Promise<T>): Promise<T | null> =>
          errorShell
            ? branch.catch((error: unknown) => {
                if (isStaticGenerationAccessError(error)) throw error;
                return null;
              })
            : branch;
        const metadata = settle(
          resolveHttpAccessFallbackMetadata({
            applyFileBasedMetadata: options.applyFileBasedMetadata,
            basePath: options.basePath ?? "",
            ...fallbackHeadOptions,
            metadataRoutes: options.metadataRoutes,
            routePath: options.route?.pattern ?? pathname,
          }),
        );
        const viewport = settle<Viewport>(resolveHttpAccessFallbackViewport(fallbackHeadOptions));
        void metadata.catch(() => null);
        void viewport.catch(() => null);
        return { metadata, viewport };
      };
      const resolveConventionHead = async (settings?: { errorShell?: boolean }) => {
        const conventionHead = startConventionHead(settings);
        const [metadata, viewport] = await Promise.all([
          conventionHead.metadata,
          conventionHead.viewport,
        ]);
        return { metadata, viewport };
      };
      const route = options.route;
      const routeHead = options.routeHead;
      if (routeHead && route) {
        // Next.js answers a document whose render throws notFound(), forbidden()
        // or unauthorized() with an error shell headed by the convention's
        // metadata, but the browser then renders the route's own Flight
        // payload, whose head resolved the route's metadata as though nothing
        // threw. Client navigations get that head too. vinext renders the
        // boundary into the document itself, so it uses the head the visitor
        // ends up with: the one the route's render already prepared, so its
        // generateMetadata() runs once. Each branch settles a signal on its
        // own, through the route's not-found convention, as Next.js's
        // metadata and viewport trees do.
        // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/app-render/app-render.tsx (getErrorRSCPayload)
        // https://github.com/vercel/next.js/blob/canary/packages/next/src/client/app-index.tsx (__next_error__)
        const prepareRouteHead = (): AppPagePreparedRouteHead => {
          if (routeHead.prepared) return routeHead.prepared;
          // The render threw before its head started, so it resolves here, from
          // the whole route rather than the layouts the fallback renders, with
          // the same branches and query as the route's own render. Like
          // Next.js's findHeadInCache, a slot intercept keeps the source
          // route's head when a page comes before its slot, and a sibling
          // intercept's page heads the route.
          const fullRouteSegments = route.routeSegments ?? [];
          const routePrimaryParallelBranch = resolvePrimaryParallelBranch(fullRouteSegments);
          const sourceParallelBranches = resolveActiveParallelRouteHeadInputs({
            layoutTreePositions: route.layoutTreePositions,
            params: options.matchedParams,
            routeSegments: fullRouteSegments,
            slotParams,
            slots: route.slots ?? null,
          });
          const interceptSlotKey =
            intercept?.interceptPage != null && !isSiblingIntercept
              ? (intercept.interceptSlotKey ?? null)
              : null;
          const routeParallelBranches =
            interceptSlotKey === null ||
            slotInterceptKeepsSourceHead({
              interceptSlotKey,
              route,
              sourceParallelRoutes: sourceParallelBranches,
            })
              ? sourceParallelBranches
              : resolveActiveParallelRouteHeadInputs({
                  interceptBranchSegments: intercept?.interceptBranchSegments ?? null,
                  interceptLayouts: intercept?.interceptLayouts ?? null,
                  interceptLayoutSegments: intercept?.interceptLayoutSegments ?? null,
                  interceptNotFoundBranchSegments:
                    intercept?.interceptNotFoundBranchSegments ?? null,
                  interceptNotFound: intercept?.interceptNotFound ?? null,
                  interceptNotFoundTreePosition: intercept?.interceptNotFoundTreePosition ?? null,
                  interceptPage: intercept?.interceptPage ?? null,
                  interceptParams: intercept?.interceptParams ?? null,
                  interceptSlotKey,
                  interceptSourcePageSegments: intercept?.interceptSourcePageSegments ?? null,
                  layoutTreePositions: route.layoutTreePositions,
                  params: options.matchedParams,
                  routeSegments: fullRouteSegments,
                  slotParams,
                  slots: route.slots ?? null,
                });
          const routeLayoutModules = route.layouts ?? options.rootLayouts;
          const headOptions = {
            applyFileBasedMetadata: options.applyFileBasedMetadata,
            basePath: options.basePath ?? "",
            layoutModules: routeLayoutModules,
            layoutTreePositions: route.layoutTreePositions,
            metadataRoutes: options.metadataRoutes,
            pageModule: isSiblingIntercept ? null : (route.page ?? null),
            parallelRoutes: [
              ...(routePrimaryParallelBranch ? [routePrimaryParallelBranch.head] : []),
              ...routeParallelBranches.map((branch) => branch.head),
            ],
            params: effectiveParams,
            routePath: route.pattern ?? pathname,
            routeSegments: route.routeSegments ?? null,
            // The query the route's own head resolution read: a cache
            // candidate's request query, whose read is observed below so the
            // response is never stored, or none for a regeneration.
            searchParams: routeHead.searchParams,
            // Reads count as the render's own would, so `dynamic = "error"`
            // still fails a metadata read of searchParams.
            searchParamsObserver: createAppPageMetadataSearchParamsObserver(
              routeHead.observeSearchParams,
            ),
          };
          const recoveredHead = recoverAppPageRouteHead(prepareAppPageHead(headOptions), {
            applyFileBasedMetadata: options.applyFileBasedMetadata,
            basePath: options.basePath ?? "",
            metadataRoutes: options.metadataRoutes,
            resolvePlanOptions: () =>
              createRouteNotFoundHeadPlanOptions({
                parallelBranches: routeParallelBranches,
                params: effectiveParams,
                primaryParallelBranch: routePrimaryParallelBranch,
                rootNotFoundModule: options.rootNotFoundModule,
                route: { ...route, layouts: routeLayoutModules },
              }),
            routePath: route.pattern ?? pathname,
          });
          return {
            ...recoveredHead,
            metadataPlacement:
              routeHead.streamMetadata && hasAppPageDynamicMetadata(headOptions) ? "body" : "head",
          };
        };
        const routeHeadResult = prepareRouteHead();
        // The route's outlet, which would report a `dynamic = "error"` access
        // error from its head, never renders here, so the fallback rethrows it.
        const throwIfAccessError = async () => {
          const accessError = await routeHeadResult.accessError;
          if (accessError) throw accessError;
        };
        // Next.js's document error shell still resolves the convention's head.
        // An HTML-limited bot waits for it, as Next.js holds the document for
        // one. Any other document waits for its viewport only, which Next.js
        // renders outside Suspense, and streams its metadata behind Suspense,
        // so a slow not-found generateMetadata() never holds back the error
        // page. vinext's document carries the route's head, so for it only the
        // settling counts: dynamic usage, or a `dynamic = "error"` failure,
        // which the viewport hits before any byte is sent. An RSC response is
        // the route's own payload, without an error shell.
        // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/app-render/app-render.tsx (getErrorRSCPayload)
        const conventionHeadBranches = options.isRscRequest
          ? null
          : startConventionHead({ errorShell: true });
        const isHtmlLimitedBot = options.serveStreamingMetadata === false;
        let conventionHead: typeof head | null = null;
        if (conventionHeadBranches && isHtmlLimitedBot) {
          const [metadata, viewport] = await Promise.all([
            conventionHeadBranches.metadata,
            conventionHeadBranches.viewport,
          ]);
          conventionHead = { metadata, viewport };
        } else if (conventionHeadBranches) {
          await conventionHeadBranches.viewport;
          // It rejects only with a `dynamic = "error"` access error, which
          // fails the response rather than the Suspense boundary.
          streamedConventionHead = conventionHeadBranches.metadata.catch(() => null);
          lateAccessErrors.push(
            conventionHeadBranches.metadata.then(
              () => null,
              (error: unknown) => (isStaticGenerationAccessError(error) ? error : null),
            ),
          );
        }
        // Like the route's own render, a document streams generated metadata
        // behind Suspense, so a slow generateMetadata() never holds back the
        // error page, as Next.js flushes its error shell first. An RSC
        // response is buffered whole, so its head stays in place.
        if (!options.isRscRequest && routeHeadResult.metadataPlacement === "body") {
          streamedRouteMetadata = routeHeadResult.metadata;
          lateAccessErrors.push(routeHeadResult.accessError);
          head = { metadata: null, viewport: await routeHeadResult.viewport };
        } else {
          const [metadata, viewport] = await Promise.all([
            routeHeadResult.metadata,
            routeHeadResult.viewport,
            throwIfAccessError(),
          ]);
          head = { metadata, viewport };
        }
        // An HTML-limited bot reads only the document, and Next.js's error
        // shell resolves the convention's metadata for it; the route's own
        // head reaches nothing but the Flight payload such a bot never runs.
        // Next.js still renders that payload, so the route's head settled
        // above, and a `dynamic = "error"` access error from it has failed the
        // render. A render that may be stored keeps the route's head: Next.js
        // stores the same entry whichever user agent triggers the render or
        // its regeneration, and visitors see its route title. One that turned
        // dynamic is never stored, so the bot gets the convention head, as
        // Next.js serves it on a dynamic 404. Both heads have settled here.
        // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/app-render/app-render.tsx (getErrorRSCPayload)
        if (
          conventionHead &&
          !streamedRouteMetadata &&
          isHtmlLimitedBot &&
          (!options.isCacheCandidate || isRenderDynamicLatched())
        ) {
          head = conventionHead;
        }
      } else {
        head = await resolveConventionHead();
      }
    } else {
      head = await resolveAppPageHead({
        applyFileBasedMetadata: options.applyFileBasedMetadata,
        basePath: options.basePath ?? "",
        layoutModules: headLayoutModules,
        layoutTreePositions: resolveHttpAccessFallbackHeadLayoutTreePositions(
          options.route,
          headLayoutModules,
        ),
        metadataRoutes: options.metadataRoutes,
        pageModule: headBoundaryModule,
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
        // As for the route's own render: relative canonical and alternate URLs
        // resolve against the normalized route pathname, never the `.rsc` or
        // pre-rewrite request path.
        pathname: routePathname,
        trailingSlash: options.trailingSlash,
      }),
    );
  }
  if (viewport) headElements.push(createElement(ViewportHead, { key: "viewport", viewport }));
  const bodyElements: ReactNode[] = [];
  if (streamedRouteMetadata) {
    bodyElements.push(
      // As in the route's own render: a persistent hidden host boundary lets
      // the shell flush while the metadata's Suspense branch is still open.
      createElement(
        "div",
        { hidden: true, key: "streamed-metadata" },
        createElement(
          Suspense,
          { fallback: null },
          createElement(AppPageBoundaryStreamedMetadata, {
            metadata: streamedRouteMetadata,
            pathname: routePathname,
            scriptNonce: options.scriptNonce,
            trailingSlash: options.trailingSlash,
          }),
        ),
      ),
    );
  }
  if (streamedConventionHead) {
    bodyElements.push(
      createElement(
        "div",
        { hidden: true, key: "error-shell-metadata" },
        createElement(
          Suspense,
          { fallback: null },
          createElement(AppPageBoundarySettledHead, { head: streamedConventionHead }),
        ),
      ),
    );
  }

  const skipLayoutWrapping = options.skipLayoutWrapping ?? false;
  const element = wrapRenderedBoundaryElement({
    element: createElement(
      Fragment,
      null,
      ...headElements,
      createElement(boundaryComponent),
      ...bodyElements,
    ),
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

  const response = await renderAppPageBoundaryElementResponse({
    ...options,
    // When global-not-found owns the document, no layouts should contribute to
    // the RSC payload's layout entries either — otherwise the SSR pipeline
    // would expect a root-layout tree path that doesn't exist in the markup.
    element,
    handleSpecialErrors: true,
    layoutModules: skipLayoutWrapping ? [] : layoutModules,
    mirrorNextFlight: true,
    navigationParams: options.matchedParams,
    route: skipLayoutWrapping ? null : options.route,
    routePattern: options.route?.pattern,
    status: options.statusCode,
  });
  return failOnLateAccessError(response, lateAccessErrors);
}

export async function renderAppPageErrorBoundary<TModule extends AppPageModule>(
  options: RenderAppPageErrorBoundaryOptions<TModule>,
): Promise<Response | null> {
  const layoutErrorBoundary =
    options.route && options.throwingLayoutIndex !== undefined
      ? resolveAppPageLayoutErrorBoundary({
          getDefaultExport,
          errorModules: options.route.errorPaths,
          errorTreePositions: options.route.errorTreePositions,
          globalErrorModule: options.globalErrorModule,
          layoutErrorModules: options.route.errors,
          layoutIndex: options.throwingLayoutIndex,
          layoutTreePositions: options.route.layoutTreePositions,
        })
      : null;
  const errorBoundary =
    layoutErrorBoundary ??
    resolveAppPageErrorBoundary({
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
  const routeLayoutModules = options.route?.layouts ?? options.rootLayouts;
  // The throwing layout and those below the boundary that catches it don't
  // render: the boundary replaces its segment's children.
  const layoutModules = layoutErrorBoundary
    ? routeLayoutModules.slice(0, layoutErrorBoundary.layoutCount)
    : routeLayoutModules;
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

  // The error rejected the document's shell before any byte was sent, so
  // Next.js answers 500 whichever boundary catches it, error.tsx included
  // (`renderToStream` in app-render.tsx). Only a streamed error, inside a
  // Suspense boundary, keeps the 200 the first chunk already sent. A flight
  // response for a local boundary keeps 200, as Next.js' dynamic flight render
  // never changes its status.
  // https://github.com/vercel/next.js/blob/v16.2.6/packages/next/src/server/app-render/app-render.tsx
  const isServerErrorResponse = errorBoundary.isGlobalError || !options.isRscRequest;

  const renderWith = async (BoundaryComponent: AppPageComponent): Promise<Response> => {
    const response = await renderAppPageBoundaryElementResponse({
      ...options,
      element: buildElement(BoundaryComponent),
      initialDevServerError: rawError,
      layoutModules,
      navigationParams: matchedParams,
      route: options.route,
      routePattern: options.route?.pattern,
      status: isServerErrorResponse ? 500 : 200,
    });
    if (isServerErrorResponse) {
      applyCdnResponseHeaders(response.headers, { cacheControl: NEVER_CACHE_CONTROL });
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
