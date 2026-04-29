import { Suspense, type ComponentType, type ReactNode } from "react";
import {
  APP_INTERCEPTION_CONTEXT_KEY,
  APP_ROOT_LAYOUT_KEY,
  APP_ROUTE_KEY,
  APP_UNMATCHED_SLOT_WIRE_VALUE,
  createAppPayloadPageId,
  createAppPayloadRouteId,
  type AppElements,
} from "./app-elements.js";
import {
  ErrorBoundary,
  ForbiddenBoundary,
  NotFoundBoundary,
  UnauthorizedBoundary,
} from "../shims/error-boundary.js";
import { LayoutSegmentProvider } from "../shims/layout-segment-context.js";
import { MetadataHead, ViewportHead, type Metadata, type Viewport } from "../shims/metadata.js";
import { Children, ParallelSlot, Slot } from "../shims/slot.js";
import type { AppPageParams } from "./app-page-boundary.js";
import {
  createAppRenderDependency,
  renderAfterAppDependencies,
  renderWithAppDependencyBarrier,
  type AppRenderDependency,
} from "./app-render-dependency.js";
import { resolveAppPageSegmentParams } from "./app-page-params.js";

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

type AppPageErrorModule = Record<string, unknown> & {
  default?: AppPageErrorComponent | null | undefined;
};

type AppPageRouteWiringSlot<
  TModule extends AppPageModule = AppPageModule,
  TErrorModule extends AppPageErrorModule = AppPageErrorModule,
> = {
  /** Slot prop name passed to the owning layout (e.g. "modal" from @modal). */
  name: string;
  default?: TModule | null;
  error?: TErrorModule | null;
  layout?: TModule | null;
  layoutIndex: number;
  loading?: TModule | null;
  page?: TModule | null;
  routeSegments?: readonly string[] | null;
};

type AppPageRouteWiringRoute<
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
  forbidden?: TModule | null;
  forbiddens?: readonly (TModule | null | undefined)[] | null;
  unauthorized?: TModule | null;
  unauthorizeds?: readonly (TModule | null | undefined)[] | null;
  routeSegments?: readonly string[];
  /**
   * Keyed by stable slot id (name + owner path), not necessarily the slot prop name.
   */
  slots?: Readonly<Record<string, AppPageRouteWiringSlot<TModule, TErrorModule>>> | null;
  templateTreePositions?: readonly number[] | null;
  templates?: readonly (TModule | null | undefined)[] | null;
};

export type AppPageSlotOverride<TModule extends AppPageModule = AppPageModule> = {
  layoutModules?: readonly (TModule | null | undefined)[] | null;
  pageModule: TModule;
  params?: AppPageParams;
  props?: Readonly<Record<string, unknown>>;
};

type AppPageLayoutEntry<
  TModule extends AppPageModule = AppPageModule,
  TErrorModule extends AppPageErrorModule = AppPageErrorModule,
> = {
  errorModule?: TErrorModule | null | undefined;
  forbiddenModule?: TModule | null | undefined;
  id: string;
  layoutModule?: TModule | null | undefined;
  notFoundModule?: TModule | null | undefined;
  unauthorizedModule?: TModule | null | undefined;
  treePath: string;
  treePosition: number;
};

type BuildAppPageRouteElementOptions<
  TModule extends AppPageModule = AppPageModule,
  TErrorModule extends AppPageErrorModule = AppPageErrorModule,
> = {
  element: ReactNode;
  globalErrorModule?: TErrorModule | null;
  makeThenableParams: (params: AppPageParams) => unknown;
  matchedParams: AppPageParams;
  resolvedMetadata: Metadata | null;
  resolvedViewport: Viewport;
  rootForbiddenModule?: TModule | null;
  rootNotFoundModule?: TModule | null;
  rootUnauthorizedModule?: TModule | null;
  route: AppPageRouteWiringRoute<TModule, TErrorModule>;
  slotOverrides?: Readonly<Record<string, AppPageSlotOverride<TModule>>> | null;
};

type BuildAppPageElementsOptions<
  TModule extends AppPageModule = AppPageModule,
  TErrorModule extends AppPageErrorModule = AppPageErrorModule,
> = BuildAppPageRouteElementOptions<TModule, TErrorModule> & {
  interceptionContext?: string | null;
  isRscRequest?: boolean;
  mountedSlotIds?: ReadonlySet<string> | null;
  routePath: string;
};

type AppPageTemplateEntry<TModule extends AppPageModule = AppPageModule> = {
  id: string;
  templateModule?: TModule | null | undefined;
  treePath: string;
  treePosition: number;
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
  > & {
    forbiddens?: readonly (TModule | null | undefined)[] | null;
    unauthorizeds?: readonly (TModule | null | undefined)[] | null;
  },
): AppPageLayoutEntry<TModule, TErrorModule>[] {
  return route.layouts.map((layoutModule, index) => {
    const treePosition = route.layoutTreePositions?.[index] ?? 0;
    const treePath = createAppPageTreePath(route.routeSegments, treePosition);
    return {
      errorModule: route.errors?.[index] ?? null,
      forbiddenModule: route.forbiddens?.[index] ?? null,
      id: `layout:${treePath}`,
      layoutModule,
      notFoundModule: route.notFounds?.[index] ?? null,
      unauthorizedModule: route.unauthorizeds?.[index] ?? null,
      treePath,
      treePosition,
    };
  });
}

function createAppPageTemplateEntries<TModule extends AppPageModule>(
  route: Pick<
    AppPageRouteWiringRoute<TModule>,
    "routeSegments" | "templateTreePositions" | "templates"
  >,
): AppPageTemplateEntry<TModule>[] {
  return (route.templates ?? []).map((templateModule, index) => {
    const treePosition = route.templateTreePositions?.[index] ?? 0;
    const treePath = createAppPageTreePath(route.routeSegments, treePosition);
    return {
      id: `template:${treePath}`,
      templateModule,
      treePath,
      treePosition,
    };
  });
}

export function resolveAppPageChildSegments(
  routeSegments: readonly string[],
  treePosition: number,
  params: AppPageParams,
): string[] {
  const rawSegments = routeSegments.slice(treePosition);
  const resolvedSegments: string[] = [];

  for (const segment of rawSegments) {
    if (
      segment.startsWith("[[...") &&
      segment.endsWith("]]") &&
      segment.length > "[[...x]]".length - 1
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

function resolveAppPageVisibleSegments(
  routeSegments: readonly string[],
  params: AppPageParams,
): string[] {
  const resolvedSegments = resolveAppPageChildSegments(routeSegments, 0, params);
  return resolvedSegments.filter((segment) => !(segment.startsWith("(") && segment.endsWith(")")));
}

function resolveAppPageTemplateKey(
  routeSegments: readonly string[],
  treePosition: number,
  params: AppPageParams,
): string {
  const visibleSegments = resolveAppPageVisibleSegments(routeSegments.slice(treePosition), params);
  return visibleSegments[0] ?? "";
}

function createAppPageParallelSlotEntries<
  TModule extends AppPageModule,
  TErrorModule extends AppPageErrorModule,
>(
  layoutIndex: number,
  layoutEntries: readonly AppPageLayoutEntry<TModule, TErrorModule>[],
  route: AppPageRouteWiringRoute<TModule, TErrorModule>,
  getEffectiveSlotParams: (slotKey: string, slotName: string) => AppPageParams,
): Readonly<Record<string, ReactNode>> | undefined {
  const parallelSlots: Record<string, ReactNode> = {};

  for (const [slotKey, slot] of Object.entries(route.slots ?? {})) {
    const slotName = slot.name;
    const targetIndex = slot.layoutIndex >= 0 ? slot.layoutIndex : layoutEntries.length - 1;
    if (targetIndex !== layoutIndex) {
      continue;
    }

    const layoutEntry = layoutEntries[targetIndex];
    const treePath = layoutEntry?.treePath ?? "/";
    const slotParams = getEffectiveSlotParams(slotKey, slotName);
    const slotSegments = slot.routeSegments
      ? resolveAppPageChildSegments(slot.routeSegments, 0, slotParams)
      : [];
    parallelSlots[slotName] = (
      <LayoutSegmentProvider segmentMap={{ children: slotSegments }}>
        <Slot id={`slot:${slotName}:${treePath}`} />
      </LayoutSegmentProvider>
    );
  }

  return Object.keys(parallelSlots).length > 0 ? parallelSlots : undefined;
}

function createAppPageRouteHead(metadata: Metadata | null, viewport: Viewport): ReactNode {
  return (
    <>
      <meta charSet="utf-8" />
      {metadata ? <MetadataHead metadata={metadata} /> : null}
      <ViewportHead viewport={viewport} />
    </>
  );
}

export function buildAppPageElements<
  TModule extends AppPageModule,
  TErrorModule extends AppPageErrorModule,
>(options: BuildAppPageElementsOptions<TModule, TErrorModule>): AppElements {
  const elements: Record<string, ReactNode | string | null> = {};
  const interceptionContext = options.interceptionContext ?? null;
  const routeId = createAppPayloadRouteId(options.routePath, interceptionContext);
  const pageId = createAppPayloadPageId(options.routePath, interceptionContext);
  const layoutEntries = createAppPageLayoutEntries(options.route);
  const templateEntries = createAppPageTemplateEntries(options.route);
  const layoutEntriesByTreePosition = new Map<number, AppPageLayoutEntry<TModule, TErrorModule>>();
  const templateEntriesByTreePosition = new Map<number, AppPageTemplateEntry<TModule>>();
  for (const layoutEntry of layoutEntries) {
    layoutEntriesByTreePosition.set(layoutEntry.treePosition, layoutEntry);
  }
  for (const templateEntry of templateEntries) {
    templateEntriesByTreePosition.set(templateEntry.treePosition, templateEntry);
  }
  const layoutIndicesByTreePosition = new Map<number, number>();
  for (let index = 0; index < layoutEntries.length; index++) {
    layoutIndicesByTreePosition.set(layoutEntries[index].treePosition, index);
  }
  const layoutDependenciesByIndex = new Map<number, AppRenderDependency>();
  const layoutDependenciesBefore: AppRenderDependency[][] = [];
  const slotDependenciesByLayoutIndex: AppRenderDependency[][] = [];
  const templateDependenciesById = new Map<string, AppRenderDependency>();
  const templateDependenciesBeforeById = new Map<string, AppRenderDependency[]>();
  const pageDependencies: AppRenderDependency[] = [];
  const rootLayoutTreePath = layoutEntries[0]?.treePath ?? null;
  const slotNameCounts = new Map<string, number>();
  for (const slot of Object.values(options.route.slots ?? {})) {
    const slotName = slot.name;
    slotNameCounts.set(slotName, (slotNameCounts.get(slotName) ?? 0) + 1);
  }
  const orderedTreePositions = Array.from(
    new Set<number>([
      ...layoutEntries.map((entry) => entry.treePosition),
      ...templateEntries.map((entry) => entry.treePosition),
    ]),
  ).sort((left, right) => left - right);
  const resolveSlotOverride = (slotKey: string, slotName: string) => {
    const overrideByKey = options.slotOverrides?.[slotKey];
    if (overrideByKey) {
      return overrideByKey;
    }

    // Legacy callers may still provide overrides by slot prop name.
    // Only allow that fallback when it is unambiguous.
    if (slotKey === slotName || (slotNameCounts.get(slotName) ?? 0) === 1) {
      return options.slotOverrides?.[slotName];
    }

    return undefined;
  };
  const getEffectiveSlotParams = (slotKey: string, slotName: string): AppPageParams =>
    resolveSlotOverride(slotKey, slotName)?.params ?? options.matchedParams;

  for (const treePosition of orderedTreePositions) {
    const layoutIndex = layoutIndicesByTreePosition.get(treePosition);
    if (layoutIndex !== undefined) {
      const layoutEntry = layoutEntries[layoutIndex];
      layoutDependenciesBefore[layoutIndex] = [...pageDependencies];
      if (getDefaultExport(layoutEntry.layoutModule)) {
        const layoutDependency = createAppRenderDependency();
        layoutDependenciesByIndex.set(layoutIndex, layoutDependency);
        pageDependencies.push(layoutDependency);
      }
      slotDependenciesByLayoutIndex[layoutIndex] = [...pageDependencies];
    }

    const templateEntry = templateEntriesByTreePosition.get(treePosition);
    if (!templateEntry || !getDefaultExport(templateEntry.templateModule)) {
      continue;
    }

    const templateDependency = createAppRenderDependency();
    templateDependenciesById.set(templateEntry.id, templateDependency);
    templateDependenciesBeforeById.set(templateEntry.id, [...pageDependencies]);
    pageDependencies.push(templateDependency);
  }

  elements[APP_ROUTE_KEY] = routeId;
  elements[APP_INTERCEPTION_CONTEXT_KEY] = interceptionContext;
  elements[APP_ROOT_LAYOUT_KEY] = rootLayoutTreePath;
  elements[pageId] = renderAfterAppDependencies(options.element, pageDependencies);

  for (const templateEntry of templateEntries) {
    const templateComponent = getDefaultExport(templateEntry.templateModule);
    if (!templateComponent) {
      continue;
    }
    const TemplateComponent = templateComponent;
    const templateDependency = templateDependenciesById.get(templateEntry.id);
    const templateElement = templateDependency ? (
      renderWithAppDependencyBarrier(
        <TemplateComponent params={options.matchedParams}>
          <Children />
        </TemplateComponent>,
        templateDependency,
      )
    ) : (
      <TemplateComponent params={options.matchedParams}>
        <Children />
      </TemplateComponent>
    );
    elements[templateEntry.id] = renderAfterAppDependencies(
      templateElement,
      templateDependenciesBeforeById.get(templateEntry.id) ?? [],
    );
  }

  for (let index = 0; index < layoutEntries.length; index++) {
    const layoutEntry = layoutEntries[index];
    const layoutComponent = getDefaultExport(layoutEntry.layoutModule);
    if (!layoutComponent) {
      continue;
    }

    const layoutProps: Record<string, unknown> = {
      params: options.makeThenableParams(
        resolveAppPageSegmentParams(
          options.route.routeSegments,
          layoutEntry.treePosition,
          options.matchedParams,
        ),
      ),
    };

    for (const slot of Object.values(options.route.slots ?? {})) {
      const slotName = slot.name;
      const targetIndex = slot.layoutIndex >= 0 ? slot.layoutIndex : layoutEntries.length - 1;
      if (targetIndex !== index) {
        continue;
      }
      layoutProps[slotName] = <ParallelSlot name={slotName} />;
    }

    const LayoutComponent = layoutComponent;
    const layoutDependency = layoutDependenciesByIndex.get(index);
    const layoutElement = layoutDependency ? (
      renderWithAppDependencyBarrier(
        <LayoutComponent {...layoutProps}>
          <Children />
        </LayoutComponent>,
        layoutDependency,
      )
    ) : (
      <LayoutComponent {...layoutProps}>
        <Children />
      </LayoutComponent>
    );
    elements[layoutEntry.id] = renderAfterAppDependencies(
      layoutElement,
      layoutDependenciesBefore[index] ?? [],
    );
  }

  for (const [slotKey, slot] of Object.entries(options.route.slots ?? {})) {
    const slotName = slot.name;
    const targetIndex = slot.layoutIndex >= 0 ? slot.layoutIndex : layoutEntries.length - 1;
    const treePath = layoutEntries[targetIndex]?.treePath ?? "/";
    const slotId = `slot:${slotName}:${treePath}`;
    const slotOverride = resolveSlotOverride(slotKey, slotName);
    const slotParams = getEffectiveSlotParams(slotKey, slotName);
    const overrideOrPageComponent =
      getDefaultExport(slotOverride?.pageModule) ?? getDefaultExport(slot.page);
    const defaultComponent = getDefaultExport(slot.default);

    // On soft nav (RSC): omit key when only default.tsx exists and the slot is
    // already mounted on the client. Absent key means the browser retains prior
    // slot content rather than replacing it. When the slot is not yet mounted
    // (first entry into this layout), include the key so default.tsx renders.
    if (
      !overrideOrPageComponent &&
      defaultComponent &&
      options.isRscRequest &&
      options.mountedSlotIds?.has(slotId)
    ) {
      continue;
    }

    const slotComponent = overrideOrPageComponent ?? defaultComponent;

    if (!slotComponent) {
      elements[slotId] = APP_UNMATCHED_SLOT_WIRE_VALUE;
      continue;
    }

    const slotThenableParams = options.makeThenableParams(slotParams);
    const slotProps: Record<string, unknown> = {
      params: slotThenableParams,
    };
    if (slotOverride?.props) {
      Object.assign(slotProps, slotOverride.props);
    }

    const SlotComponent = slotComponent;
    let slotElement: ReactNode = <SlotComponent {...slotProps} />;
    const interceptLayouts = slotOverride?.layoutModules ?? [];

    for (let layoutIndex = interceptLayouts.length - 1; layoutIndex >= 0; layoutIndex--) {
      const interceptLayoutComponent = getDefaultExport(interceptLayouts[layoutIndex]);
      if (!interceptLayoutComponent) {
        continue;
      }
      const InterceptLayoutComponent = interceptLayoutComponent;
      slotElement = (
        <InterceptLayoutComponent params={slotThenableParams}>
          {slotElement}
        </InterceptLayoutComponent>
      );
    }

    const slotLayoutComponent = getDefaultExport(slot.layout);
    if (slotLayoutComponent) {
      const SlotLayoutComponent = slotLayoutComponent;
      slotElement = (
        <SlotLayoutComponent params={slotThenableParams}>{slotElement}</SlotLayoutComponent>
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

    elements[slotId] = renderAfterAppDependencies(
      slotElement,
      targetIndex >= 0 ? (slotDependenciesByLayoutIndex[targetIndex] ?? []) : [],
    );
  }

  let routeChildren: ReactNode = (
    <LayoutSegmentProvider segmentMap={{ children: [] }}>
      <Slot id={pageId} />
    </LayoutSegmentProvider>
  );

  const routeLoadingComponent = getDefaultExport(options.route.loading);
  if (routeLoadingComponent) {
    const RouteLoadingComponent = routeLoadingComponent;
    routeChildren = <Suspense fallback={<RouteLoadingComponent />}>{routeChildren}</Suspense>;
  }

  const lastLayoutErrorModule =
    options.route.errors && options.route.errors.length > 0
      ? options.route.errors[options.route.errors.length - 1]
      : null;
  // Next.js nesting (outer to inner): Error > Unauthorized > Forbidden > NotFound > children.
  // Building bottom-up means NotFoundBoundary must wrap first, then Forbidden, Unauthorized, Error.
  const notFoundComponent =
    getDefaultExport(options.route.notFound) ?? getDefaultExport(options.rootNotFoundModule);
  if (notFoundComponent) {
    const NotFoundComponent = notFoundComponent;
    routeChildren = (
      <NotFoundBoundary fallback={<NotFoundComponent />}>{routeChildren}</NotFoundBoundary>
    );
  }

  const forbiddenComponent =
    getDefaultExport(options.route.forbidden) ?? getDefaultExport(options.rootForbiddenModule);
  if (forbiddenComponent) {
    const ForbiddenComponent = forbiddenComponent;
    routeChildren = (
      <ForbiddenBoundary fallback={<ForbiddenComponent />}>{routeChildren}</ForbiddenBoundary>
    );
  }

  const unauthorizedComponent =
    getDefaultExport(options.route.unauthorized) ??
    getDefaultExport(options.rootUnauthorizedModule);
  if (unauthorizedComponent) {
    const UnauthorizedComponent = unauthorizedComponent;
    routeChildren = (
      <UnauthorizedBoundary fallback={<UnauthorizedComponent />}>
        {routeChildren}
      </UnauthorizedBoundary>
    );
  }

  const pageErrorComponent = getErrorBoundaryExport(options.route.error);
  if (pageErrorComponent && options.route.error !== lastLayoutErrorModule) {
    routeChildren = <ErrorBoundary fallback={pageErrorComponent}>{routeChildren}</ErrorBoundary>;
  }

  for (let index = orderedTreePositions.length - 1; index >= 0; index--) {
    const treePosition = orderedTreePositions[index];
    let segmentChildren: ReactNode = routeChildren;
    const layoutEntry = layoutEntriesByTreePosition.get(treePosition);
    const templateEntry = templateEntriesByTreePosition.get(treePosition);

    // Next.js nesting per segment (outer to inner): Layout > Template > Error > Unauthorized > Forbidden > NotFound > children.
    // Building bottom-up means NotFoundBoundary must wrap the leaf subtree first,
    // then ErrorBoundary, then Template, with the Layout slot outermost.
    if (layoutEntry) {
      const layoutNotFoundComponent = getDefaultExport(layoutEntry.notFoundModule);
      if (layoutNotFoundComponent) {
        const LayoutNotFoundComponent = layoutNotFoundComponent;
        segmentChildren = (
          <NotFoundBoundary fallback={<LayoutNotFoundComponent />}>
            {segmentChildren}
          </NotFoundBoundary>
        );
      }

      const layoutForbiddenComponent = getDefaultExport(layoutEntry.forbiddenModule);
      if (layoutForbiddenComponent) {
        const LayoutForbiddenComponent = layoutForbiddenComponent;
        segmentChildren = (
          <ForbiddenBoundary fallback={<LayoutForbiddenComponent />}>
            {segmentChildren}
          </ForbiddenBoundary>
        );
      }

      const layoutUnauthorizedComponent = getDefaultExport(layoutEntry.unauthorizedModule);
      if (layoutUnauthorizedComponent) {
        const LayoutUnauthorizedComponent = layoutUnauthorizedComponent;
        segmentChildren = (
          <UnauthorizedBoundary fallback={<LayoutUnauthorizedComponent />}>
            {segmentChildren}
          </UnauthorizedBoundary>
        );
      }

      const layoutErrorComponent = getErrorBoundaryExport(layoutEntry.errorModule);
      if (layoutErrorComponent) {
        segmentChildren = (
          <ErrorBoundary fallback={layoutErrorComponent}>{segmentChildren}</ErrorBoundary>
        );
      }
    }

    if (templateEntry && getDefaultExport(templateEntry.templateModule)) {
      segmentChildren = (
        <Slot
          id={templateEntry.id}
          key={resolveAppPageTemplateKey(
            options.route.routeSegments ?? [],
            templateEntry.treePosition,
            options.matchedParams,
          )}
        >
          {segmentChildren}
        </Slot>
      );
    }

    if (!layoutEntry) {
      routeChildren = segmentChildren;
      continue;
    }
    const layoutHasElement = getDefaultExport(layoutEntry.layoutModule) !== null;
    const layoutIndex = layoutIndicesByTreePosition.get(treePosition) ?? -1;
    const segmentMap: { children: string[] } & Record<string, string[]> = {
      children: resolveAppPageChildSegments(
        options.route.routeSegments ?? [],
        layoutEntry.treePosition,
        options.matchedParams,
      ),
    };
    for (const [slotKey, slot] of Object.entries(options.route.slots ?? {})) {
      const slotName = slot.name;
      const targetIndex = slot.layoutIndex >= 0 ? slot.layoutIndex : layoutEntries.length - 1;
      if (targetIndex !== layoutIndex) {
        continue;
      }
      const slotParams = getEffectiveSlotParams(slotKey, slotName);
      segmentMap[slotName] = slot.routeSegments
        ? resolveAppPageChildSegments(slot.routeSegments, 0, slotParams)
        : [];
    }

    routeChildren = (
      <LayoutSegmentProvider segmentMap={segmentMap}>
        {layoutHasElement ? (
          <Slot
            id={layoutEntry.id}
            parallelSlots={createAppPageParallelSlotEntries(
              layoutIndex,
              layoutEntries,
              options.route,
              getEffectiveSlotParams,
            )}
          >
            {segmentChildren}
          </Slot>
        ) : (
          segmentChildren
        )}
      </LayoutSegmentProvider>
    );
  }

  const globalErrorComponent = getErrorBoundaryExport(options.globalErrorModule);
  if (globalErrorComponent) {
    routeChildren = <ErrorBoundary fallback={globalErrorComponent}>{routeChildren}</ErrorBoundary>;
  }

  elements[routeId] = (
    <>
      {createAppPageRouteHead(options.resolvedMetadata, options.resolvedViewport)}
      {routeChildren}
    </>
  );

  return elements;
}
