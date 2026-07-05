import type { ReactNode } from "react";
import type { NavigationContext } from "vinext/shims/navigation";
import type { AppPageParams } from "./app-page-boundary.js";
import {
  renderAppPageErrorBoundary,
  renderAppPageHttpAccessFallback,
  type AppPageBoundaryRoute,
} from "./app-page-boundary-render.js";
import { DEFAULT_GLOBAL_ERROR_MODULE } from "./default-global-error-module.js";
import { DEFAULT_GLOBAL_NOT_FOUND_MODULE } from "./default-global-not-found-module.js";
import { DEFAULT_NOT_FOUND_MODULE } from "./default-not-found-module.js";
import type { AppPageFontPreload } from "./app-page-execution.js";
import type { AppPageMiddlewareContext } from "./app-page-response.js";
import type { AppPageSsrHandler } from "./app-page-stream.js";
import type { MetadataFileRoute } from "./metadata-routes.js";
import type { AppElements } from "./app-elements.js";
import type { ApplyAppPageFileBasedMetadata } from "./app-page-head.js";

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
  applyFileBasedMetadata?: ApplyAppPageFileBasedMetadata;
  clearRequestContext: () => void;
  createRscOnErrorHandler: (
    request: Request,
    pathname: string,
    routePath: string,
  ) => AppPageBoundaryOnError;
  fontProviders: AppFallbackRendererFontProviders;
  getNavigationContext: () => NavigationContext | null;
  globalErrorModule?: TModule | null;
  /** Whether experimental.globalNotFound is enabled for route-miss 404s. */
  globalNotFoundEnabled?: boolean;
  /**
   * Loader for the user's `app/global-not-found.tsx` module. When provided,
   * route-miss 404s render this module as a standalone document (skipping the
   * root layout) because it ships its own `<html>` and `<body>`. Page-triggered
   * `notFound()` calls continue to use the regular `not-found.tsx` boundary
   * inside layouts.
   *
   * Passed as a deferred loader (rather than the resolved module) so the
   * generated RSC entry can use `() => import(...)` for chunk isolation.
   * Without that isolation, the bundler co-locates global-not-found's CSS
   * with the root layout's CSS in a single chunk and the CSS minifier
   * (lightningcss) drops overlapping declarations as dead code — breaking
   * the cascade for route-miss 404s where only global-not-found is rendered.
   *
   * @see https://github.com/vercel/next.js/blob/canary/packages/next/src/server/app-render/app-render.tsx
   * @see Next.js test: test/e2e/app-dir/initial-css-order/initial-css-order.test.ts
   */
  loadGlobalNotFoundModule?: (() => Promise<TModule | null | undefined>) | null;
  makeThenableParams: (params: AppPageParams) => unknown;
  metadataRoutes: MetadataFileRoute[];
  /** Configured next.config `basePath`, threaded into file-based metadata href emission. */
  basePath?: string;
  /** Configured next.config `trailingSlash`, threaded into canonical URL rendering. */
  trailingSlash?: boolean;
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
  sourcePageSegments?: readonly string[] | null;
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
    errorOrigin?: "rsc" | "ssr",
  ) => Promise<Response | null>;
  renderHttpAccessFallback: (
    route: AppPageBoundaryRoute<TModule> | null,
    statusCode: number,
    isRscRequest: boolean,
    request: Request,
    opts: {
      boundaryComponent?: AppPageComponent | null;
      boundaryModule?: TModule | null;
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
    applyFileBasedMetadata,
    basePath = "",
    clearRequestContext,
    createRscOnErrorHandler: buildRscOnErrorHandler,
    fontProviders,
    getNavigationContext,
    globalErrorModule,
    globalNotFoundEnabled = false,
    loadGlobalNotFoundModule,
    makeThenableParams,
    metadataRoutes,
    resolveChildSegments,
    rootBoundaries,
    rscRenderer,
    sanitizer,
    ssrLoader,
    trailingSlash,
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

  // Cache the result of `loadGlobalNotFoundModule()` so subsequent route-miss
  // 404s in the same worker hit a warm import instead of re-resolving the
  // dynamic chunk. The loader itself is invoked at most once per worker;
  // failures are surfaced on every call so they don't get swallowed.
  let globalNotFoundModulePromise: Promise<TModule | null | undefined> | null = null;
  function resolveGlobalNotFoundModule(): Promise<TModule | null | undefined> | null {
    if (!loadGlobalNotFoundModule) return null;
    if (globalNotFoundModulePromise === null) {
      globalNotFoundModulePromise = Promise.resolve().then(loadGlobalNotFoundModule);
    }
    return globalNotFoundModulePromise;
  }

  return {
    async renderHttpAccessFallback(
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
        statusCode === 404 && globalNotFoundEnabled && !route && !opts?.boundaryComponent;

      if (useGlobalNotFound && loadGlobalNotFoundModule) {
        const globalNotFoundModule = await resolveGlobalNotFoundModule();
        const globalNotFoundComponent = globalNotFoundModule?.default ?? null;
        if (globalNotFoundComponent) {
          return renderAppPageHttpAccessFallback({
            applyFileBasedMetadata,
            boundaryComponent: globalNotFoundComponent,
            boundaryModule: globalNotFoundModule ?? null,
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

      const routeMissRootNotFoundModule = useGlobalNotFound
        ? (DEFAULT_GLOBAL_NOT_FOUND_MODULE as unknown as TModule)
        : effectiveRootNotFoundModule;

      return renderAppPageHttpAccessFallback({
        applyFileBasedMetadata,
        basePath,
        trailingSlash,
        boundaryComponent: opts?.boundaryComponent ?? null,
        boundaryModule: opts?.boundaryModule ?? null,
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
        layoutModules: useGlobalNotFound ? [] : (opts?.layouts ?? null),
        loadSsrHandler: ssrLoader,
        makeThenableParams,
        matchedParams: opts?.matchedParams ?? route?.params ?? {},
        middlewareContext: middlewareContext ?? EMPTY_MW_CTX,
        metadataRoutes,
        requestUrl: request.url,
        resolveChildSegments,
        rootForbiddenModule,
        rootLayouts: useGlobalNotFound ? [] : rootLayouts,
        rootNotFoundModule: routeMissRootNotFoundModule,
        rootUnauthorizedModule,
        route: useGlobalNotFound ? null : route,
        renderToReadableStream: rscRenderer,
        scriptNonce,
        skipLayoutWrapping: useGlobalNotFound,
        sourcePageSegments: callContext?.sourcePageSegments,
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
      errorOrigin = "rsc",
    ) {
      return renderAppPageErrorBoundary({
        applyFileBasedMetadata,
        basePath,
        trailingSlash,
        buildFontLinkHeader: fontProviders.buildFontLinkHeader,
        clearRequestContext,
        createRscOnErrorHandler(pathname, routePath) {
          return buildRscOnErrorHandler(request, pathname, routePath);
        },
        error,
        errorOrigin,
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
        sourcePageSegments: callContext?.sourcePageSegments,
      });
    },
  };
}
