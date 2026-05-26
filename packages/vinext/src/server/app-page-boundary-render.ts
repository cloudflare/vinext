import { Fragment, createElement, type ComponentType, type ReactNode } from "react";
import { buildClientHookErrorMessage } from "vinext/shims/client-hook-error";
import { ErrorBoundary } from "vinext/shims/error-boundary";
import { LayoutSegmentProvider } from "vinext/shims/layout-segment-context";
import { MetadataHead, ViewportHead } from "vinext/shims/metadata";
import type { AppPageFontPreload } from "./app-page-execution.js";
import type { AppPageMiddlewareContext } from "./app-page-response.js";
import type { MetadataFileRoute } from "./metadata-routes.js";
import { resolveAppPageHead } from "./app-page-head.js";
import {
  renderAppPageBoundaryResponse,
  resolveAppPageErrorBoundary,
  resolveAppPageHttpAccessBoundaryComponent,
  wrapAppPageBoundaryElement,
  type AppPageParams,
} from "./app-page-boundary.js";
import {
  createAppPageFontData,
  renderAppPageHtmlResponse,
  type AppPageSsrHandler,
} from "./app-page-stream.js";
import { AppElementsWire, type AppElements } from "./app-elements.js";
import { createAppPageLayoutEntries } from "./app-page-route-wiring.js";

// oxlint-disable-next-line @typescript-eslint/no-explicit-any
type AppPageComponent = ComponentType<any>;
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
  buildFontLinkHeader: (preloads: readonly AppPageFontPreload[] | null | undefined) => string;
  clearRequestContext: () => void;
  createRscOnErrorHandler: (pathname: string, routePath: string) => AppPageBoundaryOnError;
  getFontLinks: () => string[];
  getFontPreloads: () => AppPageFontPreload[];
  getFontStyles: () => string[];
  getNavigationContext: () => unknown;
  globalErrorModule?: TModule | null;
  isEdgeRuntime?: boolean;
  isRscRequest: boolean;
  loadSsrHandler: () => Promise<AppPageSsrHandler>;
  makeThenableParams: (params: AppPageParams) => unknown;
  middlewareContext: AppPageMiddlewareContext;
  metadataRoutes: MetadataFileRoute[];
  /** Configured next.config `basePath`, threaded into file-based metadata href emission. */
  basePath?: string;
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
};

type RenderAppPageHttpAccessFallbackOptions<TModule extends AppPageModule = AppPageModule> = {
  boundaryComponent?: AppPageComponent | null;
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
      return createElement(ErrorBoundary, {
        fallback: GlobalErrorComponent,
        // oxlint-disable-next-line react/no-children-prop
        children,
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

  return {
    ...AppElementsWire.createMetadataEntries({
      interceptionContext: null,
      layoutIds: layoutEntries.map((entry) => entry.id),
      rootLayoutTreePath: layoutEntries[0]?.treePath ?? null,
      routeId,
    }),
    [routeId]: options.element,
  };
}

async function renderAppPageBoundaryElementResponse<TModule extends AppPageModule>(
  options: AppPageBoundaryRenderCommonOptions<TModule> & {
    element: ReactNode;
    layoutModules: readonly (TModule | null | undefined)[];
    route?: AppPageBoundaryRoute<TModule> | null;
    routePattern?: string;
    status: number;
  },
): Promise<Response> {
  const pathname = new URL(options.requestUrl).pathname;
  const payload = createAppPageBoundaryRscPayload({
    element: options.element,
    layoutModules: options.layoutModules,
    pathname,
    route: options.route,
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
        navigationContext: options.getNavigationContext(),
        rscStream,
        scriptNonce: options.scriptNonce,
        ssrHandler,
        status: responseStatus,
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
  const boundaryComponent =
    options.boundaryComponent ??
    resolveAppPageHttpAccessBoundaryComponent({
      getDefaultExport,
      rootForbiddenModule: options.rootForbiddenModule,
      rootNotFoundModule: options.rootNotFoundModule,
      rootUnauthorizedModule: options.rootUnauthorizedModule,
      routeForbiddenModule: options.route?.forbidden,
      routeNotFoundModule: options.route?.notFound,
      routeUnauthorizedModule: options.route?.unauthorized,
      statusCode: options.statusCode,
    });
  if (!boundaryComponent) {
    return null;
  }

  const layoutModules = options.layoutModules ?? options.route?.layouts ?? options.rootLayouts;
  const pathname = new URL(options.requestUrl).pathname;
  const routeSegments = resolveHttpAccessFallbackHeadRouteSegments(options.route, layoutModules);
  const { metadata, viewport } = await resolveAppPageHead({
    basePath: options.basePath ?? "",
    layoutModules,
    layoutTreePositions: resolveHttpAccessFallbackHeadLayoutTreePositions(
      options.route,
      layoutModules,
    ),
    metadataRoutes: options.metadataRoutes,
    params: options.matchedParams,
    routePath: options.route?.pattern ?? pathname,
    routeSegments,
  });

  const headElements: ReactNode[] = [
    createElement("meta", { charSet: "utf-8", key: "charset" }),
    createElement("meta", { content: "noindex", key: "robots", name: "robots" }),
  ];
  if (metadata) {
    headElements.push(createElement(MetadataHead, { key: "metadata", metadata, pathname }));
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
  const errorObject = options.sanitizeErrorForClient(rawError);
  const matchedParams = options.matchedParams ?? options.route?.params ?? {};
  const layoutModules = options.route?.layouts ?? options.rootLayouts;
  const pathname = new URL(options.requestUrl).pathname;

  const headElements: ReactNode[] = [createElement("meta", { charSet: "utf-8", key: "charset" })];
  if (!errorBoundary.isGlobalError) {
    try {
      const { metadata, viewport } = await resolveAppPageHead({
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
        headElements.push(createElement(MetadataHead, { key: "metadata", metadata, pathname }));
      }
      headElements.push(createElement(ViewportHead, { key: "viewport", viewport }));
    } catch (error) {
      console.error(
        `[vinext] App page error boundary head resolution failed for ${options.route?.pattern ?? pathname}:`,
        error,
      );
    }
  }

  const element = wrapRenderedBoundaryElement({
    element: createElement(
      Fragment,
      null,
      ...headElements,
      createElement(errorBoundary.component, {
        error: errorObject,
      }),
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

  return renderAppPageBoundaryElementResponse({
    ...options,
    element,
    layoutModules,
    route: options.route,
    routePattern: options.route?.pattern,
    status: 200,
  });
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
