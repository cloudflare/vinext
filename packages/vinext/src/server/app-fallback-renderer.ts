import type { ReactNode } from "react";
import type { AppPageParams } from "./app-page-boundary.js";
import {
  renderAppPageErrorBoundary,
  renderAppPageHttpAccessFallback,
  type AppPageBoundaryRoute,
} from "./app-page-boundary-render.js";
import { DEFAULT_GLOBAL_ERROR_MODULE } from "./default-global-error-module.js";
import { DEFAULT_NOT_FOUND_MODULE } from "./default-not-found-module.js";
import type { AppPageFontPreload } from "./app-page-execution.js";
import type { AppPageMiddlewareContext } from "./app-page-response.js";
import type { AppPageSsrHandler } from "./app-page-stream.js";
import type { MetadataFileRoute } from "./metadata-routes.js";
import type { AppElements } from "./app-elements.js";

// oxlint-disable-next-line @typescript-eslint/no-explicit-any
type AppPageComponent = import("react").ComponentType<any>;
type AppPageModule = Record<string, unknown> & {
  default?: AppPageComponent | null | undefined;
};
type AppPageBoundaryOnError = (
  error: unknown,
  requestInfo: unknown,
  errorContext: unknown,
) => unknown;

type AppFallbackRendererRootBoundaries<TModule extends AppPageModule = AppPageModule> = {
  rootForbiddenModule?: TModule | null;
  rootLayouts: readonly (TModule | null | undefined)[];
  rootNotFoundModule?: TModule | null;
  rootUnauthorizedModule?: TModule | null;
};

type AppFallbackRendererFontProviders = {
  buildFontLinkHeader: (preloads: readonly AppPageFontPreload[] | null | undefined) => string;
  getFontLinks: () => string[];
  getFontPreloads: () => AppPageFontPreload[];
  getFontStyles: () => string[];
};

type AppFallbackRendererOptions<TModule extends AppPageModule = AppPageModule> = {
  clearRequestContext: () => void;
  createRscOnErrorHandler: (
    request: Request,
    pathname: string,
    routePath: string,
  ) => AppPageBoundaryOnError;
  fontProviders: AppFallbackRendererFontProviders;
  getNavigationContext: () => unknown;
  globalErrorModule?: TModule | null;
  /**
   * Optional `app/global-not-found.tsx` module. When provided, route-miss 404s
   * render this module as a standalone document (skipping the root layout)
   * because it ships its own `<html>` and `<body>`. Page-triggered `notFound()`
   * calls continue to use the regular `not-found.tsx` boundary inside layouts.
   * @see https://github.com/vercel/next.js/blob/canary/packages/next/src/server/app-render/app-render.tsx
   */
  globalNotFoundModule?: TModule | null;
  makeThenableParams: (params: AppPageParams) => unknown;
  metadataRoutes: MetadataFileRoute[];
  /** Configured next.config `basePath`, threaded into file-based metadata href emission. */
  basePath?: string;
  resolveChildSegments: (
    routeSegments: readonly string[],
    treePosition: number,
    params: AppPageParams,
  ) => string[];
  rootBoundaries: AppFallbackRendererRootBoundaries<TModule>;
  rscRenderer: (
    element: ReactNode | AppElements,
    options: { onError: AppPageBoundaryOnError },
  ) => ReadableStream<Uint8Array>;
  sanitizer: (error: Error) => Error;
  ssrLoader: () => Promise<AppPageSsrHandler>;
};

type AppFallbackRendererCallContext = {
  /**
   * Whether the matched (or invoking) route opts into Next.js' edge runtime via
   * `export const runtime = "edge"`. Propagated so boundary/error/not-found
   * responses carry `x-edge-runtime: 1` for edge routes, matching the page
   * render path. Defaults to `false` when no route is matched.
   */
  isEdgeRuntime?: boolean;
};

type AppFallbackRenderer<TModule extends AppPageModule = AppPageModule> = {
  renderErrorBoundary: (
    route: AppPageBoundaryRoute<TModule> | null,
    error: unknown,
    isRscRequest: boolean,
    request: Request,
    matchedParams: AppPageParams | undefined,
    scriptNonce: string | undefined,
    middlewareContext: AppPageMiddlewareContext,
    callContext?: AppFallbackRendererCallContext,
  ) => Promise<Response | null>;
  renderHttpAccessFallback: (
    route: AppPageBoundaryRoute<TModule> | null,
    statusCode: number,
    isRscRequest: boolean,
    request: Request,
    opts: {
      boundaryComponent?: AppPageComponent | null;
      layouts?: readonly (TModule | null | undefined)[] | null;
      matchedParams?: AppPageParams;
    },
    scriptNonce: string | undefined,
    middlewareContext: AppPageMiddlewareContext,
    callContext?: AppFallbackRendererCallContext,
  ) => Promise<Response | null>;
  renderNotFound: (
    route: AppPageBoundaryRoute<TModule> | null,
    isRscRequest: boolean,
    request: Request,
    matchedParams: AppPageParams | undefined,
    scriptNonce: string | undefined,
    middlewareContext: AppPageMiddlewareContext,
    callContext?: AppFallbackRendererCallContext,
  ) => Promise<Response | null>;
};

const EMPTY_MW_CTX: AppPageMiddlewareContext = { headers: null, status: null };

export function createAppFallbackRenderer<TModule extends AppPageModule>(
  options: AppFallbackRendererOptions<TModule>,
): AppFallbackRenderer<TModule> {
  const {
    basePath = "",
    clearRequestContext,
    createRscOnErrorHandler: buildRscOnErrorHandler,
    fontProviders,
    getNavigationContext,
    globalErrorModule,
    globalNotFoundModule,
    makeThenableParams,
    metadataRoutes,
    resolveChildSegments,
    rootBoundaries,
    rscRenderer,
    sanitizer,
    ssrLoader,
  } = options;

  const { rootForbiddenModule, rootLayouts, rootNotFoundModule, rootUnauthorizedModule } =
    rootBoundaries;

  // When the app does not define `app/global-error.tsx`, fall back to vinext's
  // built-in default global error component so that uncaught render errors
  // produce the same UI Next.js ships out of the box (matching markup, inline
  // styles, theme CSS, and the "ERROR <digest>" footer for server errors).
  // See packages/vinext/src/shims/default-global-error.tsx and
  // packages/vinext/src/server/default-global-error-module.ts.
  const effectiveGlobalErrorModule: TModule | null =
    globalErrorModule ?? (DEFAULT_GLOBAL_ERROR_MODULE as unknown as TModule);

  // When the app does not define `app/not-found.tsx` (and has not opted into
  // `app/global-not-found.tsx`), fall back to vinext's built-in default
  // not-found component so route-miss 404s render the canonical Next.js
  // markup (status + "This page could not be found." message). Matches the
  // default not-found UI shipped with Next.js's app loader.
  // See packages/vinext/src/shims/default-not-found.tsx and
  // packages/vinext/src/server/default-not-found-module.ts.
  const effectiveRootNotFoundModule: TModule | null =
    rootNotFoundModule ?? (DEFAULT_NOT_FOUND_MODULE as unknown as TModule);

  return {
    renderHttpAccessFallback(
      route,
      statusCode,
      isRscRequest,
      request,
      opts,
      scriptNonce,
      middlewareContext,
      callContext,
    ) {
      // global-not-found.tsx replaces the root layout for route-miss 404s.
      // Only applies when:
      //   - The user defined app/global-not-found.tsx
      //   - The 404 originates from a route miss (no matched route)
      //   - The caller did not already pick a specific boundary component
      // Page-triggered notFound() calls (route is non-null) keep using the
      // regular not-found.tsx boundary inside the route's layouts.
      // See https://github.com/vercel/next.js/blob/canary/packages/next/src/server/app-render/app-render.tsx#L495-L520
      const useGlobalNotFound =
        statusCode === 404 && !!globalNotFoundModule && !route && !opts?.boundaryComponent;

      if (useGlobalNotFound) {
        const globalNotFoundComponent = globalNotFoundModule?.default ?? null;
        if (globalNotFoundComponent) {
          return renderAppPageHttpAccessFallback({
            boundaryComponent: globalNotFoundComponent,
            buildFontLinkHeader: fontProviders.buildFontLinkHeader,
            clearRequestContext,
            createRscOnErrorHandler(pathname, routePath) {
              return buildRscOnErrorHandler(request, pathname, routePath);
            },
            getFontLinks: fontProviders.getFontLinks,
            getFontPreloads: fontProviders.getFontPreloads,
            getFontStyles: fontProviders.getFontStyles,
            getNavigationContext,
            globalErrorModule: effectiveGlobalErrorModule,
            isEdgeRuntime: callContext?.isEdgeRuntime,
            isRscRequest,
            layoutModules: [],
            loadSsrHandler: ssrLoader,
            makeThenableParams,
            matchedParams: opts?.matchedParams ?? {},
            middlewareContext: middlewareContext ?? EMPTY_MW_CTX,
            metadataRoutes,
            requestUrl: request.url,
            resolveChildSegments,
            rootForbiddenModule: null,
            rootLayouts: [],
            rootNotFoundModule: null,
            rootUnauthorizedModule: null,
            route: null,
            renderToReadableStream: rscRenderer,
            scriptNonce,
            skipLayoutWrapping: true,
            statusCode,
          });
        }
      }

      return renderAppPageHttpAccessFallback({
        basePath,
        boundaryComponent: opts?.boundaryComponent ?? null,
        buildFontLinkHeader: fontProviders.buildFontLinkHeader,
        clearRequestContext,
        createRscOnErrorHandler(pathname, routePath) {
          return buildRscOnErrorHandler(request, pathname, routePath);
        },
        getFontLinks: fontProviders.getFontLinks,
        getFontPreloads: fontProviders.getFontPreloads,
        getFontStyles: fontProviders.getFontStyles,
        getNavigationContext,
        globalErrorModule: effectiveGlobalErrorModule,
        isEdgeRuntime: callContext?.isEdgeRuntime,
        isRscRequest,
        layoutModules: opts?.layouts ?? null,
        loadSsrHandler: ssrLoader,
        makeThenableParams,
        matchedParams: opts?.matchedParams ?? route?.params ?? {},
        middlewareContext: middlewareContext ?? EMPTY_MW_CTX,
        metadataRoutes,
        requestUrl: request.url,
        resolveChildSegments,
        rootForbiddenModule,
        rootLayouts,
        rootNotFoundModule: effectiveRootNotFoundModule,
        rootUnauthorizedModule,
        route,
        renderToReadableStream: rscRenderer,
        scriptNonce,
        statusCode,
      });
    },

    renderNotFound(
      route,
      isRscRequest,
      request,
      matchedParams,
      scriptNonce,
      middlewareContext,
      callContext,
    ) {
      return this.renderHttpAccessFallback(
        route,
        404,
        isRscRequest,
        request,
        { matchedParams },
        scriptNonce,
        middlewareContext,
        callContext,
      );
    },

    renderErrorBoundary(
      route,
      error,
      isRscRequest,
      request,
      matchedParams,
      scriptNonce,
      middlewareContext,
      callContext,
    ) {
      return renderAppPageErrorBoundary({
        basePath,
        buildFontLinkHeader: fontProviders.buildFontLinkHeader,
        clearRequestContext,
        createRscOnErrorHandler(pathname, routePath) {
          return buildRscOnErrorHandler(request, pathname, routePath);
        },
        error,
        getFontLinks: fontProviders.getFontLinks,
        getFontPreloads: fontProviders.getFontPreloads,
        getFontStyles: fontProviders.getFontStyles,
        getNavigationContext,
        globalErrorModule: effectiveGlobalErrorModule,
        isEdgeRuntime: callContext?.isEdgeRuntime,
        isRscRequest,
        loadSsrHandler: ssrLoader,
        makeThenableParams,
        matchedParams: matchedParams ?? route?.params ?? {},
        middlewareContext: middlewareContext ?? EMPTY_MW_CTX,
        metadataRoutes,
        requestUrl: request.url,
        resolveChildSegments,
        rootLayouts,
        route,
        renderToReadableStream: rscRenderer,
        sanitizeErrorForClient: sanitizer,
        scriptNonce,
      });
    },
  };
}
