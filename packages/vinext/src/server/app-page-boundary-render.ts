import { Fragment, createElement, type ComponentType, type ReactNode } from "react";
import { ErrorBoundary } from "../shims/error-boundary.js";
import { LayoutSegmentProvider } from "../shims/layout-segment-context.js";
import {
  MetadataHead,
  ViewportHead,
  mergeMetadata,
  mergeViewport,
  resolveModuleMetadata,
  resolveModuleViewport,
  type Metadata,
  type Viewport,
} from "../shims/metadata.js";
import type { AppPageFontPreload } from "./app-page-execution.js";
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

type AppPageComponent = ComponentType<any>;
type AppPageModule = Record<string, unknown> & {
  default?: AppPageComponent | null | undefined;
};
type AppPageBoundaryOnError = (
  error: unknown,
  requestInfo: unknown,
  errorContext: unknown,
) => unknown;

export interface AppPageBoundaryRoute<TModule extends AppPageModule = AppPageModule> {
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
}

interface AppPageBoundaryRenderCommonOptions<TModule extends AppPageModule = AppPageModule> {
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
  renderToReadableStream: (
    element: ReactNode,
    options: { onError: AppPageBoundaryOnError },
  ) => ReadableStream<Uint8Array>;
  requestUrl: string;
  resolveChildSegments: (
    routeSegments: readonly string[],
    treePosition: number,
    params: AppPageParams,
  ) => string[];
  rootLayouts: readonly (TModule | null | undefined)[];
}

export interface RenderAppPageHttpAccessFallbackOptions<
  TModule extends AppPageModule = AppPageModule,
> extends AppPageBoundaryRenderCommonOptions<TModule> {
  boundaryComponent?: AppPageComponent | null;
  layoutModules?: readonly (TModule | null | undefined)[] | null;
  matchedParams: AppPageParams;
  rootForbiddenModule?: TModule | null;
  rootNotFoundModule?: TModule | null;
  rootUnauthorizedModule?: TModule | null;
  route?: AppPageBoundaryRoute<TModule> | null;
  statusCode: number;
}

export interface RenderAppPageErrorBoundaryOptions<
  TModule extends AppPageModule = AppPageModule,
> extends AppPageBoundaryRenderCommonOptions<TModule> {
  error: unknown;
  matchedParams?: AppPageParams | null;
  route?: AppPageBoundaryRoute<TModule> | null;
  sanitizeErrorForClient: (error: Error) => Error;
}

function getDefaultExport<TModule extends AppPageModule>(
  module: TModule | null | undefined,
): AppPageComponent | null {
  return module?.default ?? null;
}

async function resolveAppPageLayoutHead<TModule extends AppPageModule>(
  layoutModules: readonly (TModule | null | undefined)[],
  params: AppPageParams,
): Promise<{ metadata: Metadata | null; viewport: Viewport }> {
  const filteredLayouts = layoutModules.filter(Boolean) as TModule[];
  const layoutMetadataPromises: Promise<Metadata | null>[] = [];
  let accumulatedMetadata = Promise.resolve<Metadata>({});

  for (let index = 0; index < filteredLayouts.length; index++) {
    const parentForLayout = accumulatedMetadata;
    const metadataPromise = resolveModuleMetadata(
      filteredLayouts[index],
      params,
      undefined,
      parentForLayout,
    ).catch((error) => {
      console.error("[vinext] Layout generateMetadata() failed:", error);
      return null;
    });
    layoutMetadataPromises.push(metadataPromise);
    accumulatedMetadata = metadataPromise.then(async (metadataResult) => {
      if (metadataResult) {
        return mergeMetadata([await parentForLayout, metadataResult]);
      }
      return parentForLayout;
    });
  }

  const [metadataResults, viewportResults] = await Promise.all([
    Promise.all(layoutMetadataPromises),
    Promise.all(
      filteredLayouts.map((layoutModule) =>
        resolveModuleViewport(layoutModule, params).catch((error) => {
          console.error("[vinext] Layout generateViewport() failed:", error);
          return null;
        }),
      ),
    ),
  ]);

  const metadataList = metadataResults.filter(Boolean) as Metadata[];
  const viewportList = viewportResults.filter(Boolean) as Viewport[];

  return {
    metadata: metadataList.length > 0 ? mergeMetadata(metadataList) : null,
    viewport: mergeViewport(viewportList),
  };
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
        children,
      });
    },
    renderLayout(LayoutComponent, children, asyncParams) {
      return createElement(LayoutComponent as AppPageComponent, {
        children,
        params: asyncParams,
      });
    },
    renderLayoutSegmentProvider(childSegments, children) {
      return createElement(
        LayoutSegmentProvider as ComponentType<any>,
        { childSegments },
        children,
      );
    },
    resolveChildSegments: options.resolveChildSegments,
    routeSegments: options.routeSegments ?? [],
    skipLayoutWrapping: options.skipLayoutWrapping,
  });
}

async function renderAppPageBoundaryElementResponse<TModule extends AppPageModule>(
  options: AppPageBoundaryRenderCommonOptions<TModule> & {
    element: ReactNode;
    routePattern?: string;
    status: number;
  },
): Promise<Response> {
  const pathname = new URL(options.requestUrl).pathname;

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
        navigationContext: options.getNavigationContext(),
        rscStream,
        ssrHandler,
        status: responseStatus,
      });
    },
    createRscOnErrorHandler() {
      return options.createRscOnErrorHandler(pathname, options.routePattern ?? pathname);
    },
    element: options.element,
    isRscRequest: options.isRscRequest,
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
  const { metadata, viewport } = await resolveAppPageLayoutHead(
    layoutModules,
    options.matchedParams,
  );

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
    routePattern: options.route?.pattern,
    status: 200,
  });
}
