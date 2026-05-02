import type { ReactNode } from "react";
import type { AppPageParams } from "./app-page-boundary.js";
import {
  renderAppPageErrorBoundary,
  renderAppPageHttpAccessFallback,
  type AppPageBoundaryRoute,
} from "./app-page-boundary-render.js";
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
  makeThenableParams: (params: AppPageParams) => unknown;
  metadataRoutes: MetadataFileRoute[];
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

type AppFallbackRenderer<TModule extends AppPageModule = AppPageModule> = {
  renderErrorBoundary: (
    route: AppPageBoundaryRoute<TModule> | null,
    error: unknown,
    isRscRequest: boolean,
    request: Request,
    matchedParams: AppPageParams | undefined,
    scriptNonce: string | undefined,
    middlewareContext: AppPageMiddlewareContext,
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
  ) => Promise<Response | null>;
  renderNotFound: (
    route: AppPageBoundaryRoute<TModule> | null,
    isRscRequest: boolean,
    request: Request,
    matchedParams: AppPageParams | undefined,
    scriptNonce: string | undefined,
    middlewareContext: AppPageMiddlewareContext,
  ) => Promise<Response | null>;
};

const EMPTY_MW_CTX: AppPageMiddlewareContext = { headers: null, status: null };

export function createAppFallbackRenderer<TModule extends AppPageModule>(
  options: AppFallbackRendererOptions<TModule>,
): AppFallbackRenderer<TModule> {
  const {
    clearRequestContext,
    createRscOnErrorHandler: buildRscOnErrorHandler,
    fontProviders,
    getNavigationContext,
    globalErrorModule,
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

  return {
    renderHttpAccessFallback(
      route,
      statusCode,
      isRscRequest,
      request,
      opts,
      scriptNonce,
      middlewareContext,
    ) {
      return renderAppPageHttpAccessFallback({
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
        globalErrorModule,
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
        rootNotFoundModule,
        rootUnauthorizedModule,
        route,
        renderToReadableStream: rscRenderer,
        scriptNonce,
        statusCode,
      });
    },

    renderNotFound(route, isRscRequest, request, matchedParams, scriptNonce, middlewareContext) {
      return this.renderHttpAccessFallback(
        route,
        404,
        isRscRequest,
        request,
        { matchedParams },
        scriptNonce,
        middlewareContext,
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
    ) {
      return renderAppPageErrorBoundary({
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
        globalErrorModule,
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
