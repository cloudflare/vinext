import { Fragment, createElement, type ComponentType, type ReactNode } from "react";
import { buildClientHookErrorMessage } from "../shims/client-hook-error.js";
import { ErrorBoundary } from "../shims/error-boundary.js";
import { LayoutSegmentProvider } from "../shims/layout-segment-context.js";
import { MetadataHead, ViewportHead } from "../shims/metadata.js";
import type { AppPageFontPreload } from "./app-page-execution.js";
import type { AppPageMiddlewareContext } from "./app-page-response.js";
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
import {
  APP_INTERCEPTION_CONTEXT_KEY,
  APP_ROOT_LAYOUT_KEY,
  APP_ROUTE_KEY,
  createAppPayloadRouteId,
  type AppElements,
} from "./app-elements.js";
import { resolveAppPageHead } from "./app-page-head.js";
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
  pathname: string;
  route?: AppPageBoundaryRoute<TModule> | null;
};

type AppPageBoundaryRoute<TModule extends AppPageModule = AppPageModule> = {
  error?: TModule | null;
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
  isRscRequest: boolean;
  loadSsrHandler: () => Promise<AppPageSsrHandler>;
  makeThenableParams: (params: AppPageParams) => unknown;
  middlewareContext: AppPageMiddlewareContext;
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

function resolveAppPageBoundaryRootLayoutTreePath<TModule extends AppPageModule>(
  route: AppPageBoundaryRoute<TModule> | null | undefined,
): string | null {
  if (route?.layouts) {
    const rootLayoutEntry = createAppPageLayoutEntries({
      errors: route.errors,
      layoutTreePositions: route.layoutTreePositions,
      layouts: route.layouts,
      notFounds: null,
      routeSegments: route.routeSegments,
    })[0];

    if (rootLayoutEntry) {
      return rootLayoutEntry.treePath;
    }
  }

  // Without route tree metadata we cannot derive a canonical root layout tree path.
  // Returning null keeps boundary payloads soft-navigation compatible.
  return null;
}

function createAppPageBoundaryRscPayload<TModule extends AppPageModule>(
  options: AppPageBoundaryRscPayloadOptions<TModule>,
): AppElements {
  const routeId = createAppPayloadRouteId(options.pathname, null);

  return {
    [APP_INTERCEPTION_CONTEXT_KEY]: null,
    [APP_ROUTE_KEY]: routeId,
    [APP_ROOT_LAYOUT_KEY]: resolveAppPageBoundaryRootLayoutTreePath(options.route),
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
  const { metadata, viewport } = await resolveAppPageHead({
    layoutModules,
    layoutTreePositions: options.route?.layoutTreePositions,
    params: options.matchedParams,
    routeSegments: options.route?.routeSegments,
  });

  const headElements: ReactNode[] = [
    createElement("meta", { charSet: "utf-8", key: "charset" }),
    createElement("meta", { content: "noindex", key: "robots", name: "robots" }),
  ];
  if (metadata) {
    headElements.push(createElement(MetadataHead, { key: "metadata", metadata }));
  }
  headElements.push(createElement(ViewportHead, { key: "viewport", viewport }));

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
  });

  return renderAppPageBoundaryElementResponse({
    ...options,
    element,
    layoutModules,
    route: options.route,
    routePattern: options.route?.pattern,
    status: options.statusCode,
  });
}

export async function renderAppPageErrorBoundary<TModule extends AppPageModule>(
  options: RenderAppPageErrorBoundaryOptions<TModule>,
): Promise<Response | null> {
  const errorBoundary = resolveAppPageErrorBoundary({
    getDefaultExport,
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

  const element = wrapRenderedBoundaryElement({
    element: createElement(errorBoundary.component, {
      error: errorObject,
    }),
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
