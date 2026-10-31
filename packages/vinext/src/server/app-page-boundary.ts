import { runWithFetchDedupe } from "vinext/shims/fetch-cache";
import { applyEdgeRuntimeHeader } from "./app-page-response.js";
import { mergeMiddlewareResponseHeaders } from "./middleware-response-headers.js";
import {
  VINEXT_RSC_CONTENT_TYPE,
  VINEXT_RSC_VARY_HEADER,
  applyRscCompatibilityIdHeader,
  applyRscDeploymentIdHeader,
} from "./app-rsc-cache-busting.js";
import { resolveAppPageSegmentParams } from "./app-page-params.js";
import { isAppPageRouteGroupSegment } from "./app-page-segment-state.js";

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

type ResolveAppPageHttpAccessBoundaryModuleOptions<TModule> = {
  rootForbiddenModule?: TModule | null;
  rootNotFoundModule?: TModule | null;
  rootUnauthorizedModule?: TModule | null;
  routeForbiddenModule?: TModule | null;
  routeNotFoundModule?: TModule | null;
  routeUnauthorizedModule?: TModule | null;
  statusCode: number;
};

type ResolveAppPageParentHttpAccessBoundaryModuleOptions<TModule> = {
  layoutIndex: number;
  rootForbiddenModule?: TModule | null;
  rootNotFoundModule?: TModule | null;
  rootUnauthorizedModule?: TModule | null;
  routeForbiddenModules?: readonly (TModule | null | undefined)[] | null;
  routeNotFoundModules?: readonly (TModule | null | undefined)[] | null;
  routeUnauthorizedModules?: readonly (TModule | null | undefined)[] | null;
  statusCode: number;
};

type ResolveAppPageLayoutHttpAccessBoundaryOptions<TModule> = {
  /** Segment boundaries for the status, root first, aligned with the positions. */
  boundaryModules: readonly (TModule | null | undefined)[];
  boundaryTreePositions: readonly number[];
  /** Tree position of the layout that threw. */
  layoutTreePosition: number;
};

type ResolveAppPageErrorBoundaryOptions<TModule, TComponent> = {
  getDefaultExport: (module: TModule | null | undefined) => TComponent | null | undefined;
  globalErrorModule?: TModule | null;
  errorModules?: readonly (TModule | null | undefined)[] | null;
  layoutErrorModules?: readonly (TModule | null | undefined)[] | null;
  pageErrorModule?: TModule | null;
};

type ResolveAppPageErrorBoundaryResult<TComponent> = {
  component: TComponent | null;
  isGlobalError: boolean;
};

type ResolveAppPageLayoutErrorBoundaryOptions<TModule, TComponent> = Omit<
  ResolveAppPageErrorBoundaryOptions<TModule, TComponent>,
  "pageErrorModule"
> & {
  errorTreePositions?: readonly number[] | null;
  /** The index of the route layout that threw. */
  layoutIndex: number;
  layoutTreePositions?: readonly number[] | null;
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
  isEdgeRuntime?: boolean;
  isRscRequest: boolean;
  middlewareHeaders?: Headers | null;
  renderToReadableStream: (
    element: TElement,
    options: { onError: AppPageBoundaryOnError },
  ) => ReadableStream<Uint8Array>;
  status: number;
};

export function resolveAppPageHttpAccessBoundaryComponent<TModule, TComponent>(
  options: ResolveAppPageHttpAccessBoundaryComponentOptions<TModule, TComponent>,
): TComponent | null {
  return (
    options.getDefaultExport(
      resolveAppPageHttpAccessBoundaryModule({
        rootForbiddenModule: options.rootForbiddenModule,
        rootNotFoundModule: options.rootNotFoundModule,
        rootUnauthorizedModule: options.rootUnauthorizedModule,
        routeForbiddenModule: options.routeForbiddenModule,
        routeNotFoundModule: options.routeNotFoundModule,
        routeUnauthorizedModule: options.routeUnauthorizedModule,
        statusCode: options.statusCode,
      }),
    ) ?? null
  );
}

export function resolveAppPageHttpAccessBoundaryModule<TModule>(
  options: ResolveAppPageHttpAccessBoundaryModuleOptions<TModule>,
): TModule | null {
  let boundaryModule: TModule | null | undefined;

  if (options.statusCode === 403) {
    boundaryModule = options.routeForbiddenModule ?? options.rootForbiddenModule;
  } else if (options.statusCode === 401) {
    boundaryModule = options.routeUnauthorizedModule ?? options.rootUnauthorizedModule;
  } else {
    boundaryModule = options.routeNotFoundModule ?? options.rootNotFoundModule;
  }

  return boundaryModule ?? null;
}

/**
 * The boundary that catches `notFound()` / `forbidden()` / `unauthorized()`
 * thrown by a layout: the deepest segment boundary above the layout's own
 * segment. A segment's boundary wraps its children inside its layout, so the
 * layout's own boundary, and any below it, cannot catch the layout's error.
 * Returns `null` when no segment above the layout has one (issue #4045).
 */
export function resolveAppPageLayoutHttpAccessBoundary<TModule>(
  options: ResolveAppPageLayoutHttpAccessBoundaryOptions<TModule>,
): { module: TModule; treePosition: number } | null {
  for (let index = options.boundaryTreePositions.length - 1; index >= 0; index--) {
    const treePosition = options.boundaryTreePositions[index];
    const module = options.boundaryModules[index];
    if (module && treePosition < options.layoutTreePosition) return { module, treePosition };
  }
  return null;
}

/**
 * Tree position at which the root segment's boundary catches a layout's error.
 * Next.js gives a first-layer route group the root segment's boundary (the
 * custom file or the built-in page) when the group has none of its
 * own, so the boundary renders inside the group's layout, which is often the
 * root layout. Without `app/layout`, the root layout sits deeper (for example
 * `app/[lang]/layout`), and the boundary renders inside it so the page keeps
 * its `<html>` and `<body>`. A boundary file above that root layout renders
 * there too.
 */
export function resolveAppPageRootHttpAccessBoundaryTreePosition(
  routeSegments: readonly string[],
  layoutTreePositions: readonly number[],
  layoutTreePosition: number | undefined,
): number {
  if (layoutTreePosition === undefined) return 0;
  const firstSegment = routeSegments[0];
  const groupTreePosition =
    layoutTreePosition > 1 && firstSegment !== undefined && isAppPageRouteGroupSegment(firstSegment)
      ? 1
      : 0;
  const rootLayoutTreePosition = layoutTreePositions[0] ?? 0;
  return rootLayoutTreePosition < layoutTreePosition
    ? Math.max(groupTreePosition, rootLayoutTreePosition)
    : groupTreePosition;
}

/**
 * Resolves the nearest layout-aligned boundary before `layoutIndex`, falling
 * back to the root module, and returns the layout index that owns it so
 * callers can slice the layouts array to skip layouts below the boundary owner.
 *
 * `layoutIndex` is the per-layout index where the boundary lives, or `null` if
 * the resolved boundary is the root module (which conceptually sits above all
 * layouts when no layout-level boundary is present).
 *
 * Used by the page-error fast path to make `forbidden()` / `unauthorized()` /
 * `notFound()` escalate past intermediate layouts that lack a boundary file,
 * matching Next.js's `create-component-tree.tsx` behavior where the nearest
 * ancestor boundary owns the fallback subtree.
 *
 * @see https://github.com/vercel/next.js/blob/canary/packages/next/src/server/app-render/create-component-tree.tsx
 */
export function resolveAppPageParentHttpAccessBoundary<TModule>(
  options: ResolveAppPageParentHttpAccessBoundaryModuleOptions<TModule>,
): { module: TModule | null; layoutIndex: number | null } {
  let routeModules = options.routeNotFoundModules;
  let rootModule = options.rootNotFoundModule;

  if (options.statusCode === 403) {
    routeModules = options.routeForbiddenModules;
    rootModule = options.rootForbiddenModule;
  } else if (options.statusCode === 401) {
    routeModules = options.routeUnauthorizedModules;
    rootModule = options.rootUnauthorizedModule;
  }

  if (routeModules) {
    for (let index = options.layoutIndex - 1; index >= 0; index--) {
      const module = routeModules[index];
      if (module) {
        return { module, layoutIndex: index };
      }
    }
  }

  return { module: rootModule ?? null, layoutIndex: null };
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

  const segmentErrorModules = options.errorModules ?? options.layoutErrorModules;
  if (segmentErrorModules) {
    for (let index = segmentErrorModules.length - 1; index >= 0; index--) {
      const segmentErrorComponent = options.getDefaultExport(segmentErrorModules[index]);
      if (segmentErrorComponent) {
        return {
          component: segmentErrorComponent,
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

/**
 * The error boundary that catches an error a route layout threw. A layout's
 * own error.tsx wraps only its children, so the deepest error.tsx in a segment
 * above the layout catches it, or global-error.tsx when none does, as for the
 * root layout. `layoutCount` is the number of route layouts that render around
 * the boundary: those at or above its segment.
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/server/app-render/create-component-tree.tsx
 */
export function resolveAppPageLayoutErrorBoundary<TModule, TComponent>(
  options: ResolveAppPageLayoutErrorBoundaryOptions<TModule, TComponent>,
): ResolveAppPageErrorBoundaryResult<TComponent> & { layoutCount: number } {
  const layoutTreePosition = options.layoutTreePositions?.[options.layoutIndex];
  if (options.errorModules && options.errorTreePositions && layoutTreePosition !== undefined) {
    for (let index = options.errorModules.length - 1; index >= 0; index--) {
      const treePosition = options.errorTreePositions[index];
      if (treePosition === undefined || treePosition >= layoutTreePosition) continue;
      const component = options.getDefaultExport(options.errorModules[index]);
      if (!component) continue;
      let layoutCount = 0;
      while (
        layoutCount < options.layoutIndex &&
        (options.layoutTreePositions?.[layoutCount] ?? 0) <= treePosition
      ) {
        layoutCount++;
      }
      return { component, isGlobalError: false, layoutCount };
    }
  } else if (options.layoutErrorModules) {
    // Layout-aligned boundaries: the one at index `i` renders inside layout `i`.
    const start = Math.min(options.layoutIndex, options.layoutErrorModules.length) - 1;
    for (let index = start; index >= 0; index--) {
      const component = options.getDefaultExport(options.layoutErrorModules[index]);
      if (component) return { component, isGlobalError: false, layoutCount: index + 1 };
    }
  }

  const globalErrorComponent = options.getDefaultExport(options.globalErrorModule);
  return {
    component: globalErrorComponent ?? null,
    isGlobalError: Boolean(globalErrorComponent),
    layoutCount: 0,
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
    for (let index = options.layoutModules.length - 1; index >= 0; index--) {
      const layoutComponent = options.getDefaultExport(options.layoutModules[index]);
      if (!layoutComponent) {
        continue;
      }

      const treePosition = options.layoutTreePositions ? options.layoutTreePositions[index] : 0;
      const asyncParams = options.makeThenableParams(
        resolveAppPageSegmentParams(options.routeSegments, treePosition, options.matchedParams),
      );
      element = options.renderLayout(layoutComponent, element, asyncParams);

      if (
        options.isRscRequest &&
        options.renderLayoutSegmentProvider &&
        options.resolveChildSegments
      ) {
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
  // Defensive wrap for standalone callers; idempotent under dispatchAppPage.
  // The async stream consumption that follows relies on the surrounding
  // runWithRequestContext to keep ALS state alive after this synchronous call
  // returns. See app-page-render.ts for the same pattern.
  const rscStream = runWithFetchDedupe(() =>
    options.renderToReadableStream(options.element, {
      onError: options.createRscOnErrorHandler(),
    }),
  );

  if (options.isRscRequest) {
    // Do NOT clear request-scoped context here. RSC responses are consumed lazily
    // by the client, so headers()/cookies() and async server components still need
    // their ALS-backed state while the stream is being read.
    const headers = new Headers({
      "Content-Type": VINEXT_RSC_CONTENT_TYPE,
      Vary: VINEXT_RSC_VARY_HEADER,
    });
    applyEdgeRuntimeHeader(headers, options.isEdgeRuntime);
    mergeMiddlewareResponseHeaders(headers, options.middlewareHeaders ?? null);
    applyRscCompatibilityIdHeader(headers);
    applyRscDeploymentIdHeader(headers);

    return new Response(rscStream, {
      status: options.status,
      headers,
    });
  }

  return options.createHtmlResponse(rscStream, options.status);
}
