import { Suspense, type ComponentType, type ReactNode } from "react";
import { ErrorBoundary, NotFoundBoundary } from "../shims/error-boundary.js";
import { LayoutSegmentProvider } from "../shims/layout-segment-context.js";
import { MetadataHead, ViewportHead, type Metadata, type Viewport } from "../shims/metadata.js";
import type { AppPageParams } from "./app-page-boundary.js";

type AppPageComponentProps = {
  children?: ReactNode;
  error?: Error;
  params?: unknown;
  reset?: () => void;
} & Record<string, unknown>;

type AppPageComponent = ComponentType<AppPageComponentProps>;
type AppPageErrorComponent = ComponentType<{ error: Error; reset: () => void }>;

export type AppPageModule = Record<string, unknown> & {
  default?: AppPageComponent | null | undefined;
};

export type AppPageErrorModule = Record<string, unknown> & {
  default?: AppPageErrorComponent | null | undefined;
};

export type AppPageRouteWiringSlot<
  TModule extends AppPageModule = AppPageModule,
  TErrorModule extends AppPageErrorModule = AppPageErrorModule,
> = {
  default?: TModule | null;
  error?: TErrorModule | null;
  layout?: TModule | null;
  layoutIndex: number;
  loading?: TModule | null;
  page?: TModule | null;
  /**
   * Filesystem segments from the slot's root to its active page.
   * Used to populate the LayoutSegmentProvider's segmentMap for this slot.
   * null when the slot has no active page (showing default.tsx fallback).
   */
  routeSegments?: readonly string[] | null;
};

export type AppPageRouteWiringRoute<
  TModule extends AppPageModule = AppPageModule,
  TErrorModule extends AppPageErrorModule = AppPageErrorModule,
> = {
  error?: TErrorModule | null;
  errors?: readonly (TErrorModule | null | undefined)[] | null;
  layoutTreePositions?: readonly number[] | null;
  layouts: readonly (TModule | null | undefined)[];
  loading?: TModule | null;
  notFound?: TModule | null;
  notFounds?: readonly (TModule | null | undefined)[] | null;
  routeSegments?: readonly string[];
  slots?: Readonly<Record<string, AppPageRouteWiringSlot<TModule, TErrorModule>>> | null;
  templates?: readonly (TModule | null | undefined)[] | null;
};

export type AppPageSlotOverride<TModule extends AppPageModule = AppPageModule> = {
  pageModule: TModule;
  params?: AppPageParams;
  props?: Readonly<Record<string, unknown>>;
};

export type AppPageLayoutEntry<
  TModule extends AppPageModule = AppPageModule,
  TErrorModule extends AppPageErrorModule = AppPageErrorModule,
> = {
  errorModule?: TErrorModule | null | undefined;
  id: string;
  layoutModule?: TModule | null | undefined;
  notFoundModule?: TModule | null | undefined;
  treePath: string;
  treePosition: number;
};

export type BuildAppPageRouteElementOptions<
  TModule extends AppPageModule = AppPageModule,
  TErrorModule extends AppPageErrorModule = AppPageErrorModule,
> = {
  element: ReactNode;
  globalErrorModule?: TErrorModule | null;
  makeThenableParams: (params: AppPageParams) => unknown;
  matchedParams: AppPageParams;
  resolvedMetadata: Metadata | null;
  resolvedViewport: Viewport;
  rootNotFoundModule?: TModule | null;
  route: AppPageRouteWiringRoute<TModule, TErrorModule>;
  slotOverrides?: Readonly<Record<string, AppPageSlotOverride<TModule>>> | null;
};

function getDefaultExport<TModule extends AppPageModule>(
  module: TModule | null | undefined,
): AppPageComponent | null {
  return module?.default ?? null;
}

function getErrorBoundaryExport<TModule extends AppPageErrorModule>(
  module: TModule | null | undefined,
): AppPageErrorComponent | null {
  return module?.default ?? null;
}

export function createAppPageTreePath(
  routeSegments: readonly string[] | null | undefined,
  treePosition: number,
): string {
  const treePathSegments = routeSegments?.slice(0, treePosition) ?? [];
  if (treePathSegments.length === 0) {
    return "/";
  }
  return `/${treePathSegments.join("/")}`;
}

export function createAppPageLayoutEntries<
  TModule extends AppPageModule,
  TErrorModule extends AppPageErrorModule,
>(
  route: Pick<
    AppPageRouteWiringRoute<TModule, TErrorModule>,
    "errors" | "layoutTreePositions" | "layouts" | "notFounds" | "routeSegments"
  >,
): AppPageLayoutEntry<TModule, TErrorModule>[] {
  return route.layouts.map((layoutModule, index) => {
    const treePosition = route.layoutTreePositions?.[index] ?? 0;
    const treePath = createAppPageTreePath(route.routeSegments, treePosition);
    return {
      errorModule: route.errors?.[index] ?? null,
      id: `layout:${treePath}`,
      layoutModule,
      notFoundModule: route.notFounds?.[index] ?? null,
      treePath,
      treePosition,
    };
  });
}

export function resolveAppPageChildSegments(
  routeSegments: readonly string[],
  treePosition: number,
  params: Readonly<Record<string, string | string[] | undefined>>,
): string[] {
  const rawSegments = routeSegments.slice(treePosition);
  const resolvedSegments: string[] = [];

  for (const segment of rawSegments) {
    if (
      segment.startsWith("[[...") &&
      segment.endsWith("]]") &&
      segment.length >= "[[...x]]".length
    ) {
      const paramName = segment.slice(5, -2);
      const paramValue = params[paramName];
      if (Array.isArray(paramValue) && paramValue.length === 0) {
        continue;
      }
      if (paramValue === undefined) {
        continue;
      }
      resolvedSegments.push(Array.isArray(paramValue) ? paramValue.join("/") : paramValue);
      continue;
    }

    if (segment.startsWith("[...") && segment.endsWith("]")) {
      const paramName = segment.slice(4, -1);
      const paramValue = params[paramName];
      if (Array.isArray(paramValue)) {
        resolvedSegments.push(paramValue.join("/"));
        continue;
      }
      resolvedSegments.push(paramValue ?? segment);
      continue;
    }

    if (segment.startsWith("[") && segment.endsWith("]") && !segment.includes(".")) {
      const paramName = segment.slice(1, -1);
      const paramValue = params[paramName];
      resolvedSegments.push(
        Array.isArray(paramValue) ? paramValue.join("/") : (paramValue ?? segment),
      );
      continue;
    }

    resolvedSegments.push(segment);
  }

  return resolvedSegments;
}

export function buildAppPageRouteElement<
  TModule extends AppPageModule,
  TErrorModule extends AppPageErrorModule,
>(options: BuildAppPageRouteElementOptions<TModule, TErrorModule>): ReactNode {
  let element: ReactNode = (
    <LayoutSegmentProvider segmentMap={{ children: [] }}>{options.element}</LayoutSegmentProvider>
  );

  element = (
    <>
      <meta charSet="utf-8" />
      {options.resolvedMetadata ? <MetadataHead metadata={options.resolvedMetadata} /> : null}
      <ViewportHead viewport={options.resolvedViewport} />
      {element}
    </>
  );

  const loadingComponent = getDefaultExport(options.route.loading);
  if (loadingComponent) {
    const LoadingComponent = loadingComponent;
    element = <Suspense fallback={<LoadingComponent />}>{element}</Suspense>;
  }

  const lastLayoutErrorModule =
    options.route.errors && options.route.errors.length > 0
      ? options.route.errors[options.route.errors.length - 1]
      : null;
  const pageErrorComponent = getErrorBoundaryExport(options.route.error);
  if (pageErrorComponent && options.route.error !== lastLayoutErrorModule) {
    element = <ErrorBoundary fallback={pageErrorComponent}>{element}</ErrorBoundary>;
  }

  const notFoundComponent =
    getDefaultExport(options.route.notFound) ?? getDefaultExport(options.rootNotFoundModule);
  if (notFoundComponent) {
    const NotFoundComponent = notFoundComponent;
    element = <NotFoundBoundary fallback={<NotFoundComponent />}>{element}</NotFoundBoundary>;
  }

  const templates = options.route.templates ?? [];
  for (let index = templates.length - 1; index >= 0; index--) {
    const templateComponent = getDefaultExport(templates[index]);
    if (!templateComponent) {
      continue;
    }
    const TemplateComponent = templateComponent;
    // Next.js doesn't pass params to templates at all (createElement(Template, null, children)).
    // We pass raw params here for convenience; layouts below receive thenable (Promise) params
    // to match the Next.js 15+ async params contract.
    element = <TemplateComponent params={options.matchedParams}>{element}</TemplateComponent>;
  }

  const routeSlots = options.route.slots ?? {};
  const layoutEntries = createAppPageLayoutEntries(options.route);
  const routeThenableParams = options.makeThenableParams(options.matchedParams);

  for (let index = layoutEntries.length - 1; index >= 0; index--) {
    const layoutEntry = layoutEntries[index];
    const layoutErrorComponent = getErrorBoundaryExport(layoutEntry.errorModule);
    if (layoutErrorComponent) {
      element = <ErrorBoundary fallback={layoutErrorComponent}>{element}</ErrorBoundary>;
    }

    const layoutComponent = getDefaultExport(layoutEntry.layoutModule);
    if (!layoutComponent) {
      continue;
    }

    const layoutNotFoundComponent = getDefaultExport(layoutEntry.notFoundModule);
    if (layoutNotFoundComponent) {
      const LayoutNotFoundComponent = layoutNotFoundComponent;
      element = (
        <NotFoundBoundary fallback={<LayoutNotFoundComponent />}>{element}</NotFoundBoundary>
      );
    }

    const layoutProps: Record<string, unknown> = {
      params: routeThenableParams,
    };

    for (const [slotName, slot] of Object.entries(routeSlots)) {
      const targetIndex = slot.layoutIndex >= 0 ? slot.layoutIndex : layoutEntries.length - 1;
      if (index !== targetIndex) {
        continue;
      }

      const slotOverride = options.slotOverrides?.[slotName];
      const slotParams = slotOverride?.params ?? options.matchedParams;
      const slotComponent =
        getDefaultExport(slotOverride?.pageModule) ??
        getDefaultExport(slot.page) ??
        getDefaultExport(slot.default);
      if (!slotComponent) {
        continue;
      }

      const slotProps: Record<string, unknown> = {
        params: options.makeThenableParams(slotParams),
      };
      if (slotOverride?.props) {
        Object.assign(slotProps, slotOverride.props);
      }

      const SlotComponent = slotComponent;
      let slotElement: ReactNode = <SlotComponent {...slotProps} />;

      const slotLayoutComponent = getDefaultExport(slot.layout);
      if (slotLayoutComponent) {
        const SlotLayoutComponent = slotLayoutComponent;
        slotElement = (
          <SlotLayoutComponent params={options.makeThenableParams(slotParams)}>
            {slotElement}
          </SlotLayoutComponent>
        );
      }

      const slotLoadingComponent = getDefaultExport(slot.loading);
      if (slotLoadingComponent) {
        const SlotLoadingComponent = slotLoadingComponent;
        slotElement = <Suspense fallback={<SlotLoadingComponent />}>{slotElement}</Suspense>;
      }

      const slotErrorComponent = getErrorBoundaryExport(slot.error);
      if (slotErrorComponent) {
        slotElement = <ErrorBoundary fallback={slotErrorComponent}>{slotElement}</ErrorBoundary>;
      }

      layoutProps[slotName] = slotElement;
    }

    const LayoutComponent = layoutComponent;
    element = <LayoutComponent {...layoutProps}>{element}</LayoutComponent>;

    // Build the segment map for this layout level. The "children" key always
    // contains the route segments below this layout. Named parallel slots at
    // this layout level add their own keys with per-slot segment data.
    const segmentMap: { children: string[] } & Record<string, string[]> = {
      children: resolveAppPageChildSegments(
        options.route.routeSegments ?? [],
        layoutEntry.treePosition,
        options.matchedParams,
      ),
    };
    for (const [slotName, slot] of Object.entries(routeSlots)) {
      const targetIndex = slot.layoutIndex >= 0 ? slot.layoutIndex : layoutEntries.length - 1;
      if (index !== targetIndex) {
        continue;
      }
      if (slot.routeSegments) {
        // Slot has an active page — resolve its segments (dynamic params → values)
        segmentMap[slotName] = resolveAppPageChildSegments(
          slot.routeSegments,
          0, // Slot segments are already relative to the slot root
          options.matchedParams,
        );
      } else {
        // Slot is showing default.tsx or has no page — empty segments
        segmentMap[slotName] = [];
      }
    }
    element = <LayoutSegmentProvider segmentMap={segmentMap}>{element}</LayoutSegmentProvider>;
  }

  const globalErrorComponent = getErrorBoundaryExport(options.globalErrorModule);
  if (globalErrorComponent) {
    element = <ErrorBoundary fallback={globalErrorComponent}>{element}</ErrorBoundary>;
  }

  return element;
}
