export type AppPageParams = Record<string, string | string[]>;

type ResolveAppPageHttpAccessBoundaryComponentOptions<TModule, TComponent> = {
  getDefaultExport: (module: TModule | null | undefined) => TComponent | null | undefined;
  rootForbiddenModule?: TModule | null;
  rootNotFoundModule?: TModule | null;
  rootUnauthorizedModule?: TModule | null;
  routeForbiddenModule?: TModule | null;
  routeNotFoundModule?: TModule | null;
  routeUnauthorizedModule?: TModule | null;
  statusCode: number;
};

type ResolveAppPageErrorBoundaryOptions<TModule, TComponent> = {
  getDefaultExport: (module: TModule | null | undefined) => TComponent | null | undefined;
  globalErrorModule?: TModule | null;
  layoutErrorModules?: readonly (TModule | null | undefined)[] | null;
  pageErrorModule?: TModule | null;
};

type ResolveAppPageErrorBoundaryResult<TComponent> = {
  component: TComponent | null;
  isGlobalError: boolean;
};

type WrapAppPageBoundaryElementOptions<
  TElement,
  TLayoutModule,
  TLayoutComponent,
  TChildSegments,
  TGlobalErrorComponent,
> = {
  element: TElement;
  getDefaultExport: (
    module: TLayoutModule | null | undefined,
  ) => TLayoutComponent | null | undefined;
  globalErrorComponent?: TGlobalErrorComponent | null;
  includeGlobalErrorBoundary: boolean;
  isRscRequest: boolean;
  layoutModules: readonly (TLayoutModule | null | undefined)[];
  layoutTreePositions?: readonly number[] | null;
  makeThenableParams: (params: AppPageParams) => unknown;
  matchedParams: AppPageParams;
  renderErrorBoundary: (component: TGlobalErrorComponent, children: TElement) => TElement;
  renderLayout: (component: TLayoutComponent, children: TElement, params: unknown) => TElement;
  renderLayoutSegmentProvider?: (
    segmentMap: { children: TChildSegments },
    children: TElement,
  ) => TElement;
  resolveChildSegments?: (
    routeSegments: readonly string[],
    treePosition: number,
    params: AppPageParams,
  ) => TChildSegments;
  routeSegments?: readonly string[];
  skipLayoutWrapping?: boolean;
};

type AppPageBoundaryOnError = (
  error: unknown,
  requestInfo: unknown,
  errorContext: unknown,
) => unknown;

type RenderAppPageBoundaryResponseOptions<TElement> = {
  createHtmlResponse: (rscStream: ReadableStream<Uint8Array>, status: number) => Promise<Response>;
  createRscOnErrorHandler: () => AppPageBoundaryOnError;
  element: TElement;
  isRscRequest: boolean;
  renderToReadableStream: (
    element: TElement,
    options: { onError: AppPageBoundaryOnError },
  ) => ReadableStream<Uint8Array>;
  status: number;
};

export function resolveAppPageHttpAccessBoundaryComponent<TModule, TComponent>(
  options: ResolveAppPageHttpAccessBoundaryComponentOptions<TModule, TComponent>,
): TComponent | null {
  let boundaryModule: TModule | null | undefined;

  if (options.statusCode === 403) {
    boundaryModule = options.routeForbiddenModule ?? options.rootForbiddenModule;
  } else if (options.statusCode === 401) {
    boundaryModule = options.routeUnauthorizedModule ?? options.rootUnauthorizedModule;
  } else {
    boundaryModule = options.routeNotFoundModule ?? options.rootNotFoundModule;
  }

  return options.getDefaultExport(boundaryModule) ?? null;
}

export function resolveAppPageErrorBoundary<TModule, TComponent>(
  options: ResolveAppPageErrorBoundaryOptions<TModule, TComponent>,
): ResolveAppPageErrorBoundaryResult<TComponent> {
  const pageErrorComponent = options.getDefaultExport(options.pageErrorModule);
  if (pageErrorComponent) {
    return {
      component: pageErrorComponent,
      isGlobalError: false,
    };
  }

  if (options.layoutErrorModules) {
    for (let index = options.layoutErrorModules.length - 1; index >= 0; index--) {
      const layoutErrorComponent = options.getDefaultExport(options.layoutErrorModules[index]);
      if (layoutErrorComponent) {
        return {
          component: layoutErrorComponent,
          isGlobalError: false,
        };
      }
    }
  }

  const globalErrorComponent = options.getDefaultExport(options.globalErrorModule);
  return {
    component: globalErrorComponent ?? null,
    isGlobalError: Boolean(globalErrorComponent),
  };
}

export function wrapAppPageBoundaryElement<
  TElement,
  TLayoutModule,
  TLayoutComponent,
  TChildSegments,
  TGlobalErrorComponent,
>(
  options: WrapAppPageBoundaryElementOptions<
    TElement,
    TLayoutModule,
    TLayoutComponent,
    TChildSegments,
    TGlobalErrorComponent
  >,
): TElement {
  let element = options.element;

  if (!options.skipLayoutWrapping) {
    const asyncParams = options.makeThenableParams(options.matchedParams);

    for (let index = options.layoutModules.length - 1; index >= 0; index--) {
      const layoutComponent = options.getDefaultExport(options.layoutModules[index]);
      if (!layoutComponent) {
        continue;
      }

      element = options.renderLayout(layoutComponent, element, asyncParams);

      if (
        options.isRscRequest &&
        options.renderLayoutSegmentProvider &&
        options.resolveChildSegments
      ) {
        const treePosition = options.layoutTreePositions ? options.layoutTreePositions[index] : 0;
        const childSegments = options.resolveChildSegments(
          options.routeSegments ?? [],
          treePosition,
          options.matchedParams,
        );
        element = options.renderLayoutSegmentProvider({ children: childSegments }, element);
      }
    }
  }

  if (options.isRscRequest && options.includeGlobalErrorBoundary && options.globalErrorComponent) {
    element = options.renderErrorBoundary(options.globalErrorComponent, element);
  }

  return element;
}

export async function renderAppPageBoundaryResponse<TElement>(
  options: RenderAppPageBoundaryResponseOptions<TElement>,
): Promise<Response> {
  const rscStream = options.renderToReadableStream(options.element, {
    onError: options.createRscOnErrorHandler(),
  });

  if (options.isRscRequest) {
    // Do NOT clear request-scoped context here. RSC responses are consumed lazily
    // by the client, so headers()/cookies() and async server components still need
    // their ALS-backed state while the stream is being read.
    return new Response(rscStream, {
      status: options.status,
      headers: { "Content-Type": "text/x-component; charset=utf-8", Vary: "RSC, Accept" },
    });
  }

  return options.createHtmlResponse(rscStream, options.status);
}
