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
import { resolveAppPageSpecialError, type AppPageFontPreload } from "./app-page-execution.js";
import type { AppPageMiddlewareContext } from "./app-page-response.js";
import type { MetadataFileRoute } from "./metadata-routes.js";
import { resolveAppPageHead, type ApplyAppPageFileBasedMetadata } from "./app-page-head.js";
import {
  renderAppPageBoundaryResponse,
  resolveAppPageErrorBoundary,
  resolveAppPageHttpAccessBoundaryModule,
  wrapAppPageBoundaryElement,
  type AppPageParams,
} from "./app-page-boundary.js";
import {
  createAppPageFontData,
  renderAppPageHtmlResponse,
  type AppPageSsrHandler,
} from "./app-page-stream.js";
import { AppElementsWire, type AppElements } from "./app-elements.js";
import { createAppPageLayoutEntries, createAppPageSourcePage } from "./app-page-route-wiring.js";
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
  layoutTreePositions?: readonly number[] | null;
  layouts?: readonly (TModule | null | undefined)[];
  notFound?: TModule | null;
  params?: AppPageParams;
  pattern?: string;
  routeSegments?: readonly string[];
  unauthorized?: TModule | null;
};

type AppPageBoundaryRenderCommonOptions<TModule extends AppPageModule = AppPageModule> = {
  applyFileBasedMetadata?: ApplyAppPageFileBasedMetadata;
  buildFontLinkHeader: (preloads: readonly AppPageFontPreload[] | null | undefined) => string;
  clearRequestContext: () => void;
  createRscOnErrorHandler: (pathname: string, routePath: string) => AppPageBoundaryOnError;
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
  /** Configured next.config `basePath`, threaded into file-based metadata href emission. */
  basePath?: string;
  /** Configured next.config `trailingSlash`, threaded into canonical URL rendering. */
  trailingSlash?: boolean;
  renderToReadableStream: (
    element: ReactNode | AppElements,
    options: { onError: AppPageBoundaryOnError },
  ) => ReadableStream<Uint8Array>;
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
  layoutModules?: readonly (TModule | null | undefined)[] | null;
  matchedParams: AppPageParams;
  rootForbiddenModule?: TModule | null;
  rootNotFoundModule?: TModule | null;
  rootUnauthorizedModule?: TModule | null;
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

async function renderAppPageBoundaryElementResponse<TModule extends AppPageModule>(
  options: AppPageBoundaryRenderCommonOptions<TModule> & {
    element: ReactNode;
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

  return renderAppPageBoundaryResponse({
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
      return options.createRscOnErrorHandler(pathname, options.routePattern ?? pathname);
    },
    element: payload,
    isEdgeRuntime: options.isEdgeRuntime,
    isRscRequest: options.isRscRequest,
    middlewareHeaders: options.middlewareContext.headers,
    renderToReadableStream: options.renderToReadableStream,
    status: options.status,
  });
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
  const routeSegments = resolveHttpAccessFallbackHeadRouteSegments(options.route, layoutModules);
  const { metadata, viewport } = await resolveAppPageHead({
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
