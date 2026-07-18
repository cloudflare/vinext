import { Fragment, Suspense, type ComponentType, type ReactNode } from "react";
import {
  AppElementsWire,
  APP_PREFETCH_LOADING_SHELL_MARKER_KEY,
  APP_STATIC_SIBLINGS_KEY,
  normalizeAppElementsSlotBindings,
  type AppElements,
  type AppElementsInterception,
  type AppElementsSlotBinding,
} from "./app-elements.js";
import {
  ErrorBoundary,
  ForbiddenBoundary,
  GlobalErrorBoundary,
  NotFoundBoundary,
  RedirectBoundary,
  UnauthorizedBoundary,
} from "vinext/shims/error-boundary";
import { AppRouterScrollTarget } from "vinext/shims/app-router-scroll";
import DefaultGlobalError from "vinext/shims/default-global-error";
import type { AppRouteSemanticIds } from "../routing/app-route-graph.js";
import { LayoutSegmentProvider } from "vinext/shims/layout-segment-context";
import {
  MetadataHead,
  ViewportHead,
  renderMetadataToHtml,
  type Metadata,
  type Viewport,
} from "vinext/shims/metadata";
import { Children, ParallelSlot, Slot } from "vinext/shims/slot";
import type { AppPageParams } from "./app-page-boundary.js";
import type { AppLayoutParamAccessTracker } from "./app-layout-param-observation.js";
import type { ThenableParamsObserver } from "vinext/shims/thenable-params";
import {
  createAppRenderDependency,
  registerAppElementRenderDependencies,
  renderAfterAppDependencies,
  renderWithAppDependencyBarrier,
  type AppRenderDependency,
} from "./app-render-dependency.js";
import {
  resolveAppPageBranchParams,
  resolveAppPageSegmentParamScopeKeys,
  resolveAppPageSegmentParams,
} from "./app-page-params.js";
import { probeReactServerSubtree } from "./app-page-probe.js";
import {
  APP_RSC_RENDER_MODE_NAVIGATION,
  APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL,
  type AppRscRenderMode,
} from "./app-rsc-render-mode.js";
import {
  APP_PAGE_SEGMENT_KEY,
  resolveAppPageChildSegments,
  resolveAppPageRouteStateKey,
  resolveAppPageSegmentStateKey,
} from "./app-page-segment-state.js";
import type { AppPageRenderIdentity } from "./app-page-render-identity.js";

export { resolveAppPageChildSegments } from "./app-page-segment-state.js";

type AppPageComponentProps = {
  children?: ReactNode;
  error?: unknown;
  params?: unknown;
  reset?: () => void;
} & Record<string, unknown>;

type AppPageComponent = ComponentType<AppPageComponentProps>;
type AppPageErrorComponent = ComponentType<{ error: unknown; reset: () => void }>;
const APP_PAGE_LAYOUT_PROBE_CHILD = <Fragment />;
const DEFAULT_GLOBAL_ERROR_COMPONENT = DefaultGlobalError as AppPageErrorComponent;

function resolveSlotLayoutParams(
  routeSegments: readonly string[],
  treePosition: number,
  params: AppPageParams,
): AppPageParams {
  return resolveAppPageBranchParams(routeSegments, treePosition, params);
}

export type AppPageModule = Record<string, unknown> & {
  default?: AppPageComponent | null | undefined;
};

export type AppPageErrorModule = Record<string, unknown> & {
  default?: AppPageErrorComponent | null | undefined;
};

type AppPageRouteWiringSlot<
  TModule extends AppPageModule = AppPageModule,
  TErrorModule extends AppPageErrorModule = AppPageErrorModule,
> = {
  /** Graph-owned semantic slot identity. */
  id?: string | null;
  /** Slot prop name passed to the owning layout (e.g. "modal" from @modal). */
  name: string;
  default?: TModule | null;
  configLayouts?: readonly (TModule | null | undefined)[] | null;
  configLayoutTreePositions?: readonly number[] | null;
  error?: TErrorModule | null;
  layout?: TModule | null;
  layoutIndex: number;
  loading?: TModule | null;
  loadings?: readonly (TModule | null | undefined)[] | null;
  loadingTreePositions?: readonly number[] | null;
  ownerTreePosition?: number | null;
  notFound?: TModule | null;
  notFoundTreePosition?: number | null;
  page?: TModule | null;
  routeSegments?: readonly string[] | null;
  /**
   * Full URL pattern parts for the slot's mirrored sub-page. Set when the
   * slot's params may differ from the route's (e.g. inherited slot whose
   * dynamic markers have different names than the route's). The runtime
   * matches the request URL against these parts to extract slot params.
   */
  slotPatternParts?: readonly string[] | null;
  /** Param names captured by `slotPatternParts`, in order. */
  slotParamNames?: readonly string[] | null;
};

export type AppPageRouteWiringRoute<
  TModule extends AppPageModule = AppPageModule,
  TErrorModule extends AppPageErrorModule = AppPageErrorModule,
> = {
  ids?: AppRouteSemanticIds | null;
  error?: TErrorModule | null;
  errorPaths?: readonly TErrorModule[] | null;
  errors?: readonly (TErrorModule | null | undefined)[] | null;
  errorTreePositions?: readonly number[] | null;
  layoutTreePositions?: readonly number[] | null;
  layouts: readonly (TModule | null | undefined)[];
  loading?: TModule | null;
  loadings?: readonly (TModule | null | undefined)[] | null;
  loadingTreePositions?: readonly number[] | null;
  notFound?: TModule | null;
  notFounds?: readonly (TModule | null | undefined)[] | null;
  notFoundTreePosition?: number | null;
  forbidden?: TModule | null;
  forbiddenTreePosition?: number | null;
  forbiddens?: readonly (TModule | null | undefined)[] | null;
  unauthorized?: TModule | null;
  unauthorizedTreePosition?: number | null;
  unauthorizeds?: readonly (TModule | null | undefined)[] | null;
  routeSegments?: readonly string[];
  childrenRouteSegments?: readonly string[] | null;
  /**
   * Keyed by stable slot id (name + owner path), not necessarily the slot prop name.
   */
  slots?: Readonly<Record<string, AppPageRouteWiringSlot<TModule, TErrorModule>>> | null;
  childrenSlot?: {
    id: string;
    ownerTreePath: string;
    state: AppElementsSlotBinding["state"];
  } | null;
  /**
   * Static sibling segment names at each dynamic URL level for this route. Used
   * by the client router to determine if a cached prefetch of the dynamic
   * route can be reused when navigating to a static sibling URL.
   *
   * Mirrors Next.js's `staticSiblings` tuple element on the loader-tree
   * dynamic segments — see `.nextjs-ref/packages/next/src/shared/lib/app-router-types.ts`
   * (DynamicSegmentTuple) and the loader emit in
   * `packages/next/src/build/webpack/loaders/next-app-loader/index.ts`.
   *
   * Issue: https://github.com/cloudflare/vinext/issues/1525
   */
  staticSiblings?: readonly string[] | null;
  templateTreePositions?: readonly number[] | null;
  templates?: readonly (TModule | null | undefined)[] | null;
};

export type AppPageSlotOverride<TModule extends AppPageModule = AppPageModule> = {
  branchSegments?: readonly string[] | null;
  layoutSegments?: readonly (readonly string[])[] | null;
  layoutModules?: readonly (TModule | null | undefined)[] | null;
  loadingModules?: readonly (TModule | null | undefined)[] | null;
  loadingTreePositions?: readonly number[] | null;
  /**
   * The page module to render for this slot. Optional — when omitted, the
   * slot's existing `page` is used (e.g. when the override only changes the
   * slot's `params` for an inherited mirror with distinct param names).
   */
  pageModule?: TModule | null;
  params?: AppPageParams;
  props?: Readonly<Record<string, unknown>>;
  routeSegments?: readonly string[] | null;
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
  layoutParamAccess?: AppLayoutParamAccessTracker;
  makeThenableParams: MakeThenableParams;
  matchedParams: AppPageParams;
  metadataPlacement?: "body" | "head";
  resolvedMetadata: Metadata | null;
  resolvedMetadataPathname?: string;
  resolvedViewport: Viewport;
  streamingMetadata?: Promise<Metadata | null> | null;
  streamingMetadataOutlet?: Promise<unknown> | null;
  streamingMetadataOutletSuspended?: boolean;
  streamingMetadataTags?: Promise<Metadata | null> | null;
  trailingSlash?: boolean;
  rootForbiddenModule?: TModule | null;
  rootNotFoundModule?: TModule | null;
  rootUnauthorizedModule?: TModule | null;
  route: AppPageRouteWiringRoute<TModule, TErrorModule>;
  createPageElement?: (
    component: AppPageComponent,
    props: Readonly<Record<string, unknown>>,
  ) => ReactNode;
  searchParams?: unknown;
  slotOverrides?: Readonly<Record<string, AppPageSlotOverride<TModule>>> | null;
};

type MakeThenableParams = (params: AppPageParams, observer?: ThenableParamsObserver) => unknown;

type BuildAppPageElementsOptions<
  TModule extends AppPageModule = AppPageModule,
  TErrorModule extends AppPageErrorModule = AppPageErrorModule,
> = BuildAppPageRouteElementOptions<TModule, TErrorModule> & {
  interception?: AppElementsInterception | null;
  interceptionContext?: string | null;
  isRscRequest?: boolean;
  mountedSlotIds?: ReadonlySet<string> | null;
  renderIdentity?: AppPageRenderIdentity;
  renderMode?: AppRscRenderMode;
  routePath: string;
  sourcePageSegments?: readonly string[] | null;
};

type AppPageTemplateEntry<TModule extends AppPageModule = AppPageModule> = {
  id: string;
  templateModule?: TModule | null | undefined;
  treePath: string;
  treePosition: number;
};

type AppPageErrorEntry<TErrorModule extends AppPageErrorModule = AppPageErrorModule> = {
  errorModule?: TErrorModule | null | undefined;
  treePosition: number;
};

type AppPageLoadingEntry<TModule extends AppPageModule = AppPageModule> = {
  loadingModule?: TModule | null | undefined;
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

function readFiniteRevalidateSeconds(module: AppPageModule | null | undefined): number | null {
  const revalidate = module?.revalidate;
  return typeof revalidate === "number" && Number.isFinite(revalidate) && revalidate > 0
    ? revalidate
    : null;
}

function recordLayoutSkipObservationScope(options: {
  layoutId: string;
  layoutModule: AppPageModule | null | undefined;
  layoutParamAccess: AppLayoutParamAccessTracker | undefined;
  routeSegments: readonly string[] | null | undefined;
  treePosition: number;
}): void {
  options.layoutParamAccess?.recordLayoutParamScope(
    options.layoutId,
    resolveAppPageSegmentParamScopeKeys(options.routeSegments, options.treePosition),
  );
  const revalidateSeconds = readFiniteRevalidateSeconds(options.layoutModule);
  if (revalidateSeconds !== null) {
    options.layoutParamAccess?.recordLayoutFiniteRevalidate(options.layoutId, revalidateSeconds);
  }
}

export function probeAppPageLayoutWithTracking<TModule extends AppPageModule>(options: {
  layoutIndex: number;
  layoutParamAccess: AppLayoutParamAccessTracker | undefined;
  makeThenableParams: MakeThenableParams;
  matchedParams: AppPageParams;
  route: Pick<
    AppPageRouteWiringRoute<TModule>,
    "layoutTreePositions" | "layouts" | "routeSegments"
  >;
}): unknown {
  const treePosition = options.route.layoutTreePositions?.[options.layoutIndex] ?? 0;
  const treePath = createAppPageTreePath(options.route.routeSegments, treePosition);
  const layoutId = AppElementsWire.encodeLayoutId(treePath);
  const probe = () => {
    const layoutModule = options.route.layouts[options.layoutIndex];
    const LayoutComponent = getDefaultExport(layoutModule);
    if (!LayoutComponent) return null;
    recordLayoutSkipObservationScope({
      layoutId,
      layoutModule,
      layoutParamAccess: options.layoutParamAccess,
      routeSegments: options.route.routeSegments,
      treePosition,
    });
    const layoutParams = resolveAppPageSegmentParams(
      options.route.routeSegments,
      treePosition,
      options.matchedParams,
    );
    return probeReactServerSubtree(
      <LayoutComponent
        params={options.makeThenableParams(
          layoutParams,
          options.layoutParamAccess?.createThenableParamsObserver(layoutId),
        )}
      >
        {APP_PAGE_LAYOUT_PROBE_CHILD}
      </LayoutComponent>,
    );
  };

  return options.layoutParamAccess
    ? options.layoutParamAccess.runLayoutProbe(layoutId, probe)
    : probe();
}

export function createAppPageLayoutEntries<
  TModule extends AppPageModule,
  TErrorModule extends AppPageErrorModule,
>(
  route: Pick<
    AppPageRouteWiringRoute<TModule, TErrorModule>,
    | "errors"
    | "errorTreePositions"
    | "layoutTreePositions"
    | "layouts"
    | "notFounds"
    | "routeSegments"
  > & {
    forbiddens?: readonly (TModule | null | undefined)[] | null;
    unauthorizeds?: readonly (TModule | null | undefined)[] | null;
  },
): AppPageLayoutEntry<TModule, TErrorModule>[] {
  return route.layouts.map((layoutModule, index) => {
    const treePosition = route.layoutTreePositions?.[index] ?? 0;
    const treePath = createAppPageTreePath(route.routeSegments, treePosition);
    return {
      errorModule: route.errorTreePositions ? null : (route.errors?.[index] ?? null),
      forbiddenModule: route.forbiddens?.[index] ?? null,
      id: AppElementsWire.encodeLayoutId(treePath),
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
      id: AppElementsWire.encodeTemplateId(treePath),
      templateModule,
      treePath,
      treePosition,
    };
  });
}

export function createAppPageSourcePage(
  routeSegments: readonly string[] | null | undefined,
): string {
  return `/${[...(routeSegments ?? []), "page"].join("/")}`;
}

function resolveAppPageLayoutSegmentProviderSegments(
  routeSegments: readonly string[],
  treePosition: number,
  params: AppPageParams,
): string[] {
  const segments = resolveAppPageChildSegments(routeSegments, treePosition, params);
  return segments.at(-1) === APP_PAGE_SEGMENT_KEY ? segments.slice(0, -1) : segments;
}

function createAppPageErrorEntries<TErrorModule extends AppPageErrorModule>(
  route: Pick<
    AppPageRouteWiringRoute<AppPageModule, TErrorModule>,
    "errorPaths" | "errors" | "errorTreePositions"
  >,
): AppPageErrorEntry<TErrorModule>[] {
  return (route.errorPaths ?? route.errors ?? []).flatMap((errorModule, index) => {
    if (!errorModule) return [];
    const treePosition = route.errorTreePositions?.[index];
    if (treePosition === undefined) return [];
    return [{ errorModule, treePosition }];
  });
}

function createAppPageLoadingEntries<TModule extends AppPageModule>(
  route: Pick<AppPageRouteWiringRoute<TModule>, "loadings" | "loadingTreePositions">,
): AppPageLoadingEntry<TModule>[] {
  return (route.loadings ?? []).flatMap((loadingModule, index) => {
    if (!loadingModule) return [];
    const treePosition = route.loadingTreePositions?.[index];
    if (treePosition === undefined) return [];
    return [{ loadingModule, treePosition }];
  });
}

function getPrefetchLoadingEntry<TModule extends AppPageModule>(
  route: Pick<
    AppPageRouteWiringRoute<TModule>,
    "loading" | "loadings" | "loadingTreePositions" | "routeSegments"
  >,
): AppPageLoadingEntry<TModule> | null {
  let firstEntry: AppPageLoadingEntry<TModule> | null = null;
  for (const [index, loadingModule] of (route.loadings ?? []).entries()) {
    if (!getDefaultExport(loadingModule)) continue;
    const treePosition = route.loadingTreePositions?.[index];
    if (treePosition === undefined) continue;
    if (firstEntry === null || treePosition < firstEntry.treePosition) {
      firstEntry = { loadingModule, treePosition };
    }
  }
  if (firstEntry) return firstEntry;

  // Legacy/eager route fixtures may only expose the leaf loading field.
  return getDefaultExport(route.loading)
    ? { loadingModule: route.loading, treePosition: route.routeSegments?.length ?? 0 }
    : null;
}

function createAppPageSlotLoadingEntries<TModule extends AppPageModule>(
  slot: Pick<AppPageRouteWiringSlot<TModule>, "loading" | "loadings" | "loadingTreePositions">,
  override: Pick<AppPageSlotOverride<TModule>, "loadingModules" | "loadingTreePositions"> | null,
): AppPageLoadingEntry<TModule>[] {
  const entries: AppPageLoadingEntry<TModule>[] = [];
  const slotLoadingModules =
    (slot.loadings?.length ?? 0) > 0 ? slot.loadings! : slot.loading ? [slot.loading] : [];
  const slotLoadingTreePositions =
    (slot.loadingTreePositions?.length ?? 0) > 0 ? slot.loadingTreePositions! : [0];

  for (const [index, loadingModule] of slotLoadingModules.entries()) {
    const treePosition = slotLoadingTreePositions[index];
    if (!getDefaultExport(loadingModule) || treePosition === undefined) continue;
    // An interception replaces the slot's normal active branch. Only the slot
    // root is necessarily shared; nested normal-branch loadings belong to a
    // sibling subtree and must not wrap the intercepting page.
    if (override && treePosition !== 0) continue;
    entries.push({ loadingModule, treePosition });
  }

  for (const [index, loadingModule] of (override?.loadingModules ?? []).entries()) {
    const treePosition = override?.loadingTreePositions?.[index];
    if (!getDefaultExport(loadingModule) || treePosition === undefined) continue;
    entries.push({ loadingModule, treePosition });
  }

  return entries;
}

function getFirstLoadingEntry<TModule extends AppPageModule>(
  entries: readonly AppPageLoadingEntry<TModule>[],
): AppPageLoadingEntry<TModule> | null {
  return entries.reduce<AppPageLoadingEntry<TModule> | null>(
    (first, entry) => (first === null || entry.treePosition < first.treePosition ? entry : first),
    null,
  );
}

function createAppPageParallelSlotEntries<
  TModule extends AppPageModule,
  TErrorModule extends AppPageErrorModule,
>(
  layoutIndex: number,
  layoutEntries: readonly AppPageLayoutEntry<TModule, TErrorModule>[],
  route: AppPageRouteWiringRoute<TModule, TErrorModule>,
  getEffectiveSlotParams: (slotKey: string, slotName: string) => AppPageParams,
  resolveSlotOverride: (
    slotKey: string,
    slotName: string,
  ) => AppPageSlotOverride<TModule> | undefined,
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
    const slotId = resolveAppPageSlotId(slot, treePath);
    const slotParams = getEffectiveSlotParams(slotKey, slotName);
    const routeSegments =
      resolveSlotOverride(slotKey, slotName)?.routeSegments ?? slot.routeSegments;
    const slotSegments = routeSegments
      ? resolveAppPageLayoutSegmentProviderSegments(routeSegments, 0, slotParams)
      : [];
    parallelSlots[slotName] = (
      <LayoutSegmentProvider providerId={slotId} segmentMap={{ children: slotSegments }}>
        <Slot id={slotId} />
      </LayoutSegmentProvider>
    );
  }

  return Object.keys(parallelSlots).length > 0 ? parallelSlots : undefined;
}

function resolveAppPageSlotId(slot: AppPageRouteWiringSlot, treePath: string): string {
  const slotId = AppElementsWire.encodeSlotId(slot.name, treePath);
  if (slot.id && slot.id !== slotId) {
    throw new Error(
      `[vinext] App Router slot id mismatch for @${slot.name}: graph id ${slot.id} does not match wire id ${slotId}`,
    );
  }
  return slotId;
}

function resolveAppPageSlotBindingState(
  slot: AppPageRouteWiringSlot,
  override: AppPageSlotOverride | undefined,
): AppElementsSlotBinding["state"] {
  const pageComponent = getDefaultExport(override?.pageModule) ?? getDefaultExport(slot.page);
  if (pageComponent) return "active";
  if (getDefaultExport(slot.default)) return "default";
  return "unmatched";
}

function createAppPageSlotBindings<
  TModule extends AppPageModule,
  TErrorModule extends AppPageErrorModule,
>(
  route: AppPageRouteWiringRoute<TModule, TErrorModule>,
  layoutEntries: readonly AppPageLayoutEntry<TModule, TErrorModule>[],
  resolveSlotOverride: (
    slotKey: string,
    slotName: string,
  ) => AppPageSlotOverride<TModule> | undefined,
  options: {
    interception: AppElementsInterception | null;
    interceptionContext: string | null;
    routePath: string;
  },
): readonly AppElementsSlotBinding[] {
  const bindings: AppElementsSlotBinding[] = [];
  if (route.childrenSlot) {
    const ownerLayoutId = layoutEntries.find(
      (layoutEntry) => layoutEntry.treePath === route.childrenSlot?.ownerTreePath,
    )?.id;
    bindings.push({
      ownerLayoutId: ownerLayoutId ?? null,
      slotId: route.childrenSlot.id,
      state: route.childrenSlot.state,
    });
  }
  for (const [slotKey, slot] of Object.entries(route.slots ?? {})) {
    const targetIndex = slot.layoutIndex >= 0 ? slot.layoutIndex : layoutEntries.length - 1;
    const layoutEntry = layoutEntries[targetIndex] ?? null;
    const ownerLayoutId = layoutEntry?.id ?? null;
    const override = resolveSlotOverride(slotKey, slot.name);
    const slotId = resolveAppPageSlotId(slot, layoutEntry?.treePath ?? "/");
    const state = resolveAppPageSlotBindingState(slot, override);
    const activeRouteId =
      state === "active"
        ? options.interception?.slotId === slotId
          ? options.interception.targetRouteId
          : AppElementsWire.encodeRouteId(options.routePath, null)
        : null;
    bindings.push({
      ...(activeRouteId !== null ? { activeRouteId } : {}),
      ownerLayoutId,
      slotId,
      state,
    });
  }
  return normalizeAppElementsSlotBindings(bindings, {
    layoutIds: layoutEntries.map((entry) => entry.id),
  });
}

function createAppPageRouteHead(
  metadata: Metadata | null,
  viewport: Viewport,
  pathname: string,
  metadataPlacement: "body" | "head",
  trailingSlash?: boolean,
): ReactNode {
  return (
    <>
      <meta charSet="utf-8" />
      {metadata && metadataPlacement === "head" ? (
        <MetadataHead metadata={metadata} pathname={pathname} trailingSlash={trailingSlash} />
      ) : null}
      <ViewportHead viewport={viewport} />
    </>
  );
}

export function createAppPageRouteBodyMetadata(
  metadata: Metadata | null,
  pathname: string,
  metadataPlacement: "body" | "head",
  trailingSlash?: boolean,
): ReactNode {
  if (!metadata || metadataPlacement !== "body") return null;
  return (
    <div
      hidden
      dangerouslySetInnerHTML={{
        __html: renderMetadataToHtml(metadata, pathname, { trailingSlash }),
      }}
    />
  );
}

async function AppPageStreamingMetadata(props: {
  metadata: Promise<Metadata | null>;
  pathname: string;
  trailingSlash?: boolean;
}): Promise<ReactNode> {
  try {
    const metadata = await props.metadata;
    return createAppPageRouteBodyMetadata(metadata, props.pathname, "body", props.trailingSlash);
  } catch {
    // The matching outlet below rethrows inside the route's error boundaries.
    // Keeping the tag outlet successful lets already-flushed HTML remain valid.
    return null;
  }
}
AppPageStreamingMetadata.displayName = "Vinext.StreamingMetadata";

async function AppPageMetadataOutlet(props: { metadata: Promise<unknown> }): Promise<null> {
  await props.metadata;
  return null;
}
AppPageMetadataOutlet.displayName = "Vinext.MetadataOutlet";

function createAppPageStreamingMetadataOutlet(
  elementId: string | null,
  suspended = true,
): ReactNode {
  if (!elementId) return null;
  const outlet = <Slot id={elementId} />;
  return suspended ? <Suspense fallback={null}>{outlet}</Suspense> : outlet;
}

function createAppPageStreamingMetadataBody(elementId: string | null): ReactNode {
  if (!elementId) return null;
  return (
    // React treats metadata tags as hoistable and otherwise waits for them
    // before flushing the document. Next.js uses the same persistent hidden
    // host boundary so the shell can flush while this Suspense branch is open.
    <div hidden>
      <Suspense fallback={null}>
        <Slot id={elementId} />
      </Suspense>
    </div>
  );
}

export function buildAppPageElements<
  TModule extends AppPageModule,
  TErrorModule extends AppPageErrorModule,
>(options: BuildAppPageElementsOptions<TModule, TErrorModule>): AppElements {
  const renderIdentity = options.renderIdentity;
  const interceptionContext =
    renderIdentity?.interceptionContext ?? options.interceptionContext ?? null;
  const renderMode = options.renderMode ?? APP_RSC_RENDER_MODE_NAVIGATION;
  const routeSegments = options.route.routeSegments ?? [];
  const routeResetKey = resolveAppPageRouteStateKey(routeSegments, options.matchedParams);
  const routeId =
    renderIdentity?.routeId ??
    AppElementsWire.encodeRouteId(options.routePath, interceptionContext);
  const pageId =
    renderIdentity?.pageId ?? AppElementsWire.encodePageId(options.routePath, interceptionContext);
  const pageElementId = options.route.childrenSlot?.id ?? pageId;
  const streamingMetadataBodyId = options.streamingMetadata
    ? `__vinext_streaming_metadata_body:${routeId}`
    : null;
  const streamingMetadataOutletId = options.streamingMetadataOutlet
    ? `__vinext_streaming_metadata_outlet:${routeId}`
    : null;
  const layoutEntries = createAppPageLayoutEntries(options.route);
  const templateEntries = createAppPageTemplateEntries(options.route);
  const loadingEntries = createAppPageLoadingEntries(options.route);
  const errorEntries = createAppPageErrorEntries(options.route);
  const findNearestAncestorLoadingEntry = (
    treePosition: number,
  ): AppPageLoadingEntry<TModule> | undefined => {
    for (let index = loadingEntries.length - 1; index >= 0; index--) {
      if (loadingEntries[index].treePosition < treePosition) return loadingEntries[index];
    }
    return undefined;
  };
  const findNearestLoadingEntryAtOrAbove = (
    treePosition: number,
  ): AppPageLoadingEntry<TModule> | undefined => {
    let nearest: AppPageLoadingEntry<TModule> | undefined;
    for (const entry of loadingEntries) {
      if (
        entry.treePosition <= treePosition &&
        (!nearest || entry.treePosition > nearest.treePosition)
      ) {
        nearest = entry;
      }
    }
    return nearest;
  };
  const isPrefetchLoadingShell = renderMode === APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL;
  const prefetchLoadingEntry = isPrefetchLoadingShell
    ? getPrefetchLoadingEntry(options.route)
    : null;
  const metadataPlacement = options.metadataPlacement ?? "head";
  const layoutEntriesByTreePosition = new Map<number, AppPageLayoutEntry<TModule, TErrorModule>>();
  const templateEntriesByTreePosition = new Map<number, AppPageTemplateEntry<TModule>>();
  const loadingEntriesByTreePosition = new Map<number, AppPageLoadingEntry<TModule>>();
  const errorEntriesByTreePosition = new Map<number, AppPageErrorEntry<TErrorModule>>();
  for (const layoutEntry of layoutEntries) {
    layoutEntriesByTreePosition.set(layoutEntry.treePosition, layoutEntry);
  }
  for (const templateEntry of templateEntries) {
    templateEntriesByTreePosition.set(templateEntry.treePosition, templateEntry);
  }
  for (const loadingEntry of loadingEntries) {
    loadingEntriesByTreePosition.set(loadingEntry.treePosition, loadingEntry);
  }
  for (const errorEntry of errorEntries) {
    errorEntriesByTreePosition.set(errorEntry.treePosition, errorEntry);
  }
  const layoutIndicesByTreePosition = new Map<number, number>();
  for (let index = 0; index < layoutEntries.length; index++) {
    layoutIndicesByTreePosition.set(layoutEntries[index].treePosition, index);
  }
  const layoutDependenciesByIndex = new Map<number, AppRenderDependency>();
  const renderDependenciesByElementId = new Map<string, AppRenderDependency>();
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
      ...loadingEntries.map((entry) => entry.treePosition),
      ...errorEntries.map((entry) => entry.treePosition),
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
  const prefetchSlotLoadingEntries = isPrefetchLoadingShell
    ? Object.entries(options.route.slots ?? {}).flatMap(([slotKey, slot]) => {
        const override = resolveSlotOverride(slotKey, slot.name) ?? null;
        const firstLoadingEntry = getFirstLoadingEntry(
          createAppPageSlotLoadingEntries(slot, override),
        );
        return firstLoadingEntry ? [{ ownerTreePosition: slot.ownerTreePosition ?? 0 }] : [];
      })
    : [];
  // The children spine must reach every slot owner whose branch has a loading
  // boundary. A loading on the spine itself stops traversal first, matching
  // Next.js's per-parallel-route pre-PPR component-tree walk.
  const prefetchCutoffTreePosition = isPrefetchLoadingShell
    ? (prefetchLoadingEntry?.treePosition ??
      prefetchSlotLoadingEntries.reduce(
        (deepest, entry) => Math.max(deepest, entry.ownerTreePosition),
        0,
      ))
    : null;
  const includesPrefetchTreePosition = (treePosition: number): boolean =>
    prefetchCutoffTreePosition === null || treePosition <= prefetchCutoffTreePosition;
  const elements: Record<
    string,
    | ReactNode
    | string
    | null
    | AppElementsInterception
    | readonly AppElementsSlotBinding[]
    | readonly string[]
  > = {
    ...AppElementsWire.createMetadataEntries({
      interception: renderIdentity?.interception ?? options.interception ?? null,
      interceptionContext,
      layoutIds: options.route.ids?.layouts ?? layoutEntries.map((entry) => entry.id),
      rootLayoutTreePath,
      routeId,
      sourcePage: createAppPageSourcePage(options.sourcePageSegments ?? routeSegments),
      slotBindings: createAppPageSlotBindings(options.route, layoutEntries, resolveSlotOverride, {
        interception: renderIdentity?.interception ?? options.interception ?? null,
        interceptionContext,
        routePath: options.routePath,
      }),
    }),
  };
  // Surface static-sibling info on the wire so the client router can decide
  // whether a cached dynamic-route prefetch can be reused when navigating to a
  // static sibling URL. Mirrors Next.js's loader-tree `staticSiblings` tuple
  // element (issue cloudflare/vinext#1525). Only included when the route has
  // dynamic segments with static siblings — keeps the payload lean for
  // fully-static routes.
  if (options.route.staticSiblings && options.route.staticSiblings.length > 0) {
    elements[APP_STATIC_SIBLINGS_KEY] = options.route.staticSiblings;
  }
  if (options.streamingMetadata && streamingMetadataBodyId) {
    elements[streamingMetadataBodyId] = (
      <AppPageStreamingMetadata
        metadata={options.streamingMetadataTags ?? options.streamingMetadata}
        pathname={options.resolvedMetadataPathname ?? options.routePath}
        trailingSlash={options.trailingSlash}
      />
    );
  }
  if (options.streamingMetadataOutlet && streamingMetadataOutletId) {
    elements[streamingMetadataOutletId] = (
      <AppPageMetadataOutlet metadata={options.streamingMetadataOutlet} />
    );
  }
  const getEffectiveSlotParams = (slotKey: string, slotName: string): AppPageParams =>
    resolveSlotOverride(slotKey, slotName)?.params ?? options.matchedParams;

  for (const treePosition of orderedTreePositions) {
    if (isPrefetchLoadingShell && !includesPrefetchTreePosition(treePosition)) continue;
    const layoutIndex = layoutIndicesByTreePosition.get(treePosition);
    if (layoutIndex !== undefined) {
      const layoutEntry = layoutEntries[layoutIndex];
      layoutDependenciesBefore[layoutIndex] = [...pageDependencies];
      if (getDefaultExport(layoutEntry.layoutModule)) {
        const layoutDependency = createAppRenderDependency();
        layoutDependenciesByIndex.set(layoutIndex, layoutDependency);
        renderDependenciesByElementId.set(layoutEntry.id, layoutDependency);
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

  const routeLoadingComponent = getDefaultExport(options.route.loading);
  const prefetchLoadingComponent = getDefaultExport(prefetchLoadingEntry?.loadingModule);
  const shouldRenderPrefetchLoadingShell =
    isPrefetchLoadingShell &&
    (prefetchLoadingComponent !== null || prefetchSlotLoadingEntries.length > 0);
  if (shouldRenderPrefetchLoadingShell) {
    // Client loading components serialize as module references in Flight. Keep
    // a durable marker in the shell payload so external router tests and
    // diagnostics can recognize this as a loading-boundary response without
    // requiring source text to appear in client component references.
    elements[APP_PREFETCH_LOADING_SHELL_MARKER_KEY] = "LoadingBoundary";
  }

  elements[pageElementId] = isPrefetchLoadingShell
    ? null
    : renderAfterAppDependencies(options.element, pageDependencies);

  for (const templateEntry of templateEntries) {
    if (isPrefetchLoadingShell && !includesPrefetchTreePosition(templateEntry.treePosition)) {
      continue;
    }
    const templateComponent = getDefaultExport(templateEntry.templateModule);
    if (!templateComponent) {
      continue;
    }
    const TemplateComponent = templateComponent;
    const templateDependency = templateDependenciesById.get(templateEntry.id);
    let templateElement: ReactNode = templateDependency ? (
      renderWithAppDependencyBarrier(
        <TemplateComponent>
          <Children />
        </TemplateComponent>,
        templateDependency,
      )
    ) : (
      <TemplateComponent>
        <Children />
      </TemplateComponent>
    );
    const ancestorLoadingEntry = findNearestAncestorLoadingEntry(templateEntry.treePosition);
    const ancestorLoadingComponent = getDefaultExport(ancestorLoadingEntry?.loadingModule);
    if (ancestorLoadingComponent && ancestorLoadingEntry) {
      const AncestorLoadingComponent = ancestorLoadingComponent;
      const loadingResetKey = resolveAppPageSegmentStateKey(
        routeSegments,
        ancestorLoadingEntry.treePosition,
        options.matchedParams,
      );
      templateElement = (
        <Suspense key={loadingResetKey || routeResetKey} fallback={<AncestorLoadingComponent />}>
          {templateElement}
        </Suspense>
      );
    }
    elements[templateEntry.id] = renderAfterAppDependencies(
      templateElement,
      templateDependenciesBeforeById.get(templateEntry.id) ?? [],
    );
  }

  for (let index = 0; index < layoutEntries.length; index++) {
    const layoutEntry = layoutEntries[index];
    if (isPrefetchLoadingShell && !includesPrefetchTreePosition(layoutEntry.treePosition)) {
      continue;
    }
    const layoutComponent = getDefaultExport(layoutEntry.layoutModule);
    if (!layoutComponent) {
      continue;
    }
    const layoutParams = resolveAppPageSegmentParams(
      options.route.routeSegments,
      layoutEntry.treePosition,
      options.matchedParams,
    );
    recordLayoutSkipObservationScope({
      layoutId: layoutEntry.id,
      layoutModule: layoutEntry.layoutModule,
      layoutParamAccess: options.layoutParamAccess,
      routeSegments: options.route.routeSegments,
      treePosition: layoutEntry.treePosition,
    });

    const layoutProps: Record<string, unknown> = {
      params: options.makeThenableParams(
        layoutParams,
        options.layoutParamAccess?.createThenableParamsObserver(layoutEntry.id),
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
    let layoutElement: ReactNode = layoutDependency ? (
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
    const ancestorLoadingEntry = findNearestAncestorLoadingEntry(layoutEntry.treePosition);
    const ancestorLoadingComponent = getDefaultExport(ancestorLoadingEntry?.loadingModule);
    if (ancestorLoadingComponent && ancestorLoadingEntry) {
      const AncestorLoadingComponent = ancestorLoadingComponent;
      const loadingResetKey = resolveAppPageSegmentStateKey(
        routeSegments,
        ancestorLoadingEntry.treePosition,
        options.matchedParams,
      );
      layoutElement = (
        <Suspense key={loadingResetKey || routeResetKey} fallback={<AncestorLoadingComponent />}>
          {layoutElement}
        </Suspense>
      );
    }
    elements[layoutEntry.id] = renderAfterAppDependencies(
      layoutElement,
      layoutDependenciesBefore[index] ?? [],
    );
  }

  for (const [slotKey, slot] of Object.entries(options.route.slots ?? {})) {
    const slotName = slot.name;
    const targetIndex = slot.layoutIndex >= 0 ? slot.layoutIndex : layoutEntries.length - 1;
    const targetTreePosition = layoutEntries[targetIndex]?.treePosition ?? 0;
    const ownerTreePosition = slot.ownerTreePosition ?? targetTreePosition;
    const isOwnedAtRoutePrefetchCutoff =
      isPrefetchLoadingShell &&
      prefetchLoadingEntry !== null &&
      ownerTreePosition === prefetchLoadingEntry.treePosition;
    if (
      isPrefetchLoadingShell &&
      (prefetchLoadingEntry
        ? ownerTreePosition > prefetchLoadingEntry.treePosition
        : !includesPrefetchTreePosition(targetTreePosition))
    ) {
      continue;
    }
    const treePath = layoutEntries[targetIndex]?.treePath ?? "/";
    const slotId = resolveAppPageSlotId(slot, treePath);
    const slotOverride = resolveSlotOverride(slotKey, slotName);
    const slotParams = getEffectiveSlotParams(slotKey, slotName);
    const slotRouteSegments = slotOverride?.routeSegments ?? slot.routeSegments ?? [];
    const slotOwnerParams = resolveAppPageSegmentParams(
      options.route.routeSegments,
      layoutEntries[targetIndex]?.treePosition ?? 0,
      options.matchedParams,
    );
    const slotResetKey = resolveAppPageRouteStateKey(slotRouteSegments, slotParams);
    const hasSlotTreeOverride =
      slotOverride?.pageModule != null || slotOverride?.layoutModules !== undefined;
    const slotLoadingEntries = createAppPageSlotLoadingEntries(
      slot,
      hasSlotTreeOverride ? (slotOverride ?? null) : null,
    );
    const prefetchSlotLoadingEntry = isOwnedAtRoutePrefetchCutoff
      ? prefetchLoadingEntry
      : isPrefetchLoadingShell
        ? getFirstLoadingEntry(slotLoadingEntries)
        : null;
    if (isPrefetchLoadingShell && prefetchSlotLoadingEntry === null) {
      continue;
    }
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

    if (!slotComponent && !isOwnedAtRoutePrefetchCutoff) {
      elements[slotId] = AppElementsWire.unmatchedSlotValue;
      continue;
    }

    let slotElement: ReactNode;
    if (prefetchSlotLoadingEntry) {
      const PrefetchSlotLoadingComponent = getDefaultExport(
        prefetchSlotLoadingEntry.loadingModule,
      )!;
      slotElement = <PrefetchSlotLoadingComponent />;
    } else {
      const slotThenableParams = options.makeThenableParams(slotParams);
      const slotProps: Record<string, unknown> = {
        params: slotThenableParams,
      };
      if (options.searchParams !== undefined) {
        slotProps.searchParams = options.searchParams;
      }
      if (slotOverride?.props) {
        Object.assign(slotProps, slotOverride.props);
      }
      slotElement = options.createPageElement
        ? options.createPageElement(slotComponent!, slotProps)
        : (() => {
            const SlotComponent = slotComponent!;
            return <SlotComponent {...slotProps} />;
          })();
    }
    const branchSegments = slotOverride?.branchSegments ?? slotRouteSegments;
    const branchLayouts = new Map<
      number,
      { component: AppPageComponent; params: AppPageParams }[]
    >();
    const addBranchLayout = (
      treePosition: number,
      entry: { component: AppPageComponent; params: AppPageParams },
    ) => {
      const entries = branchLayouts.get(treePosition) ?? [];
      entries.push(entry);
      branchLayouts.set(treePosition, entries);
    };

    if (hasSlotTreeOverride) {
      for (const [layoutIndex, layoutModule] of (slotOverride?.layoutModules ?? []).entries()) {
        const component = getDefaultExport(layoutModule);
        if (!component) continue;
        const treePosition =
          slotOverride?.layoutSegments?.[layoutIndex]?.length ?? branchSegments.length;
        addBranchLayout(treePosition, {
          component,
          params: resolveSlotLayoutParams(branchSegments, treePosition, slotParams),
        });
      }
    } else {
      for (const [layoutIndex, layoutModule] of (slot.configLayouts ?? []).entries()) {
        const component = getDefaultExport(layoutModule);
        if (!component) continue;
        const treePosition = slot.configLayoutTreePositions?.[layoutIndex] ?? 0;
        addBranchLayout(treePosition, {
          component,
          params: {
            ...slotOwnerParams,
            ...resolveSlotLayoutParams(slotRouteSegments, treePosition, slotParams),
          },
        });
      }
    }

    const slotLayoutComponent = overrideOrPageComponent ? getDefaultExport(slot.layout) : null;
    if (slotLayoutComponent) {
      const rootEntries = branchLayouts.get(0) ?? [];
      branchLayouts.set(0, [
        { component: slotLayoutComponent, params: slotOwnerParams },
        ...rootEntries,
      ]);
    }

    const branchLoadings = new Map<number, AppPageComponent[]>();
    for (const entry of slotLoadingEntries) {
      const component = getDefaultExport(entry.loadingModule);
      if (!component) continue;
      const components = branchLoadings.get(entry.treePosition) ?? [];
      components.push(component);
      branchLoadings.set(entry.treePosition, components);
    }

    const slotErrorComponent = getErrorBoundaryExport(slot.error);
    const branchTreePositions = Array.from(
      new Set([
        ...branchLayouts.keys(),
        ...branchLoadings.keys(),
        ...(slotErrorComponent ? [0] : []),
      ]),
    )
      .filter(
        (treePosition) =>
          !prefetchSlotLoadingEntry ||
          (!isOwnedAtRoutePrefetchCutoff && treePosition <= prefetchSlotLoadingEntry.treePosition),
      )
      .sort((left, right) => left - right);
    for (let index = branchTreePositions.length - 1; index >= 0; index--) {
      const treePosition = branchTreePositions[index];
      const loadingComponents = prefetchSlotLoadingEntry
        ? []
        : (branchLoadings.get(treePosition) ?? []);
      for (let loadingIndex = loadingComponents.length - 1; loadingIndex >= 0; loadingIndex--) {
        const LoadingComponent = loadingComponents[loadingIndex];
        const loadingResetKey = resolveAppPageSegmentStateKey(
          branchSegments,
          treePosition,
          slotParams,
        );
        slotElement = (
          <Suspense key={loadingResetKey || slotResetKey} fallback={<LoadingComponent />}>
            {slotElement}
          </Suspense>
        );
      }

      if (treePosition === 0 && slotErrorComponent) {
        slotElement = (
          <ErrorBoundary resetKey={slotResetKey} fallback={slotErrorComponent}>
            {slotElement}
          </ErrorBoundary>
        );
      }

      const layoutEntriesAtPosition = branchLayouts.get(treePosition) ?? [];
      for (let layoutIndex = layoutEntriesAtPosition.length - 1; layoutIndex >= 0; layoutIndex--) {
        const layoutEntry = layoutEntriesAtPosition[layoutIndex];
        const LayoutComponent = layoutEntry.component;
        slotElement = (
          <LayoutComponent params={options.makeThenableParams(layoutEntry.params)}>
            {slotElement}
          </LayoutComponent>
        );
      }
    }

    // A loading convention on the owning segment applies to every parallel
    // child slot, not only the flattened `children` branch. The slot payload is
    // serialized as a separate element entry, so the boundary must wrap this
    // entry directly rather than only the <Slot> placeholder in routeChildren.
    const ownerLoadingEntry = isPrefetchLoadingShell
      ? undefined
      : findNearestLoadingEntryAtOrAbove(ownerTreePosition);
    const ownerLoadingComponent = getDefaultExport(ownerLoadingEntry?.loadingModule);
    if (ownerLoadingComponent && ownerLoadingEntry) {
      const OwnerLoadingComponent = ownerLoadingComponent;
      const ownerResetKey = resolveAppPageSegmentStateKey(
        routeSegments,
        ownerLoadingEntry.treePosition,
        options.matchedParams,
      );
      slotElement = (
        <Suspense key={ownerResetKey || slotResetKey} fallback={<OwnerLoadingComponent />}>
          {slotElement}
        </Suspense>
      );
    }

    elements[slotId] = renderAfterAppDependencies(
      slotElement,
      targetIndex >= 0 ? (slotDependenciesByLayoutIndex[targetIndex] ?? []) : [],
    );
  }

  let routeChildren: ReactNode = (
    <>
      <LayoutSegmentProvider
        providerId={pageElementId}
        segmentMap={{ children: [APP_PAGE_SEGMENT_KEY] }}
      >
        <Slot id={pageElementId} />
      </LayoutSegmentProvider>
      {createAppPageStreamingMetadataOutlet(
        streamingMetadataOutletId,
        options.streamingMetadataOutletSuspended,
      )}
    </>
  );

  if (isPrefetchLoadingShell) {
    // A prefetch loading shell is a cached payload, not a committed navigation,
    // so it intentionally does not mount AppRouterScrollTarget — the scroll/focus
    // effect belongs to the real render that replaces this shell (handled in the
    // else branch below).
    if (prefetchLoadingComponent === null) {
      routeChildren = null;
    } else {
      const PrefetchLoadingComponent = prefetchLoadingComponent;
      routeChildren = <PrefetchLoadingComponent />;
    }
  } else {
    // Wrap the page slot in a per-segment RedirectBoundary so that a
    // redirect() thrown from a server component (or a client component
    // within the page subtree) is caught here — below the route's layouts —
    // rather than at the top-level boundary in app-browser-entry. Catching
    // at the top level unmounts the entire route tree including layouts,
    // which destroys client-side state in layout-hosted components
    // (counters, theme toggles, form drafts). Here, only the page subtree
    // is unmounted; the surrounding layouts stay mounted across the
    // boundary's null-render → router.replace transition, and segment
    // reuse keeps their React state intact.
    //
    // Placed inside the Suspense (loading) boundary to match Next.js nesting
    // for the redirect boundary specifically:
    //   Error > AccessFallback > Loading (Suspense) > Redirect > content
    // (Note: Next.js places AccessFallback inside Loading, not outside — that
    // is a pre-existing nesting divergence tracked separately.)
    // This keeps the loading fallback visible during redirect-driven
    // transitions rather than unmounting it.
    routeChildren = <RedirectBoundary>{routeChildren}</RedirectBoundary>;

    if (routeLoadingComponent) {
      const RouteLoadingComponent = routeLoadingComponent;
      // Route-level wrappers cover the full page branch in vinext's flat element
      // transport, so their reset key includes the visible segment-state path.
      // Dynamic param changes reset the pending boundary, while search-only changes
      // preserve it.
      routeChildren = (
        <Suspense key={routeResetKey} fallback={<RouteLoadingComponent />}>
          {routeChildren}
        </Suspense>
      );
    }

    // Mount the scroll/focus target *outside* the loading Suspense so it does
    // not suspend with the page content. Next.js places ScrollAndMaybeFocusHandler
    // above the LoadingBoundary for the same reason: the handler must stay
    // committed while the loading.js fallback renders, so the default-navigation
    // scroll fires against the loading boundary's DOM (`should apply scroll when
    // loading.js is used`) and again when the final content commits — rather than
    // relying on a raw post-navigation scrollTo fallback that only runs after the
    // streamed content resolves.
    routeChildren = <AppRouterScrollTarget>{routeChildren}</AppRouterScrollTarget>;
  }

  const lastLayoutErrorModule =
    errorEntries.length > 0 ? errorEntries[errorEntries.length - 1].errorModule : null;
  // Next.js nesting (outer to inner): Error > Unauthorized > Forbidden > NotFound > children.
  // Building bottom-up means NotFoundBoundary must wrap first, then Forbidden, Unauthorized, Error.
  const notFoundComponent =
    getDefaultExport(options.route.notFound) ?? getDefaultExport(options.rootNotFoundModule);
  if (notFoundComponent) {
    const NotFoundComponent = notFoundComponent;
    routeChildren = (
      <NotFoundBoundary resetKey={routeResetKey} fallback={<NotFoundComponent />}>
        {routeChildren}
      </NotFoundBoundary>
    );
  }

  const forbiddenComponent =
    getDefaultExport(options.route.forbidden) ?? getDefaultExport(options.rootForbiddenModule);
  if (forbiddenComponent) {
    const ForbiddenComponent = forbiddenComponent;
    routeChildren = (
      <ForbiddenBoundary resetKey={routeResetKey} fallback={<ForbiddenComponent />}>
        {routeChildren}
      </ForbiddenBoundary>
    );
  }

  const unauthorizedComponent =
    getDefaultExport(options.route.unauthorized) ??
    getDefaultExport(options.rootUnauthorizedModule);
  if (unauthorizedComponent) {
    const UnauthorizedComponent = unauthorizedComponent;
    routeChildren = (
      <UnauthorizedBoundary resetKey={routeResetKey} fallback={<UnauthorizedComponent />}>
        {routeChildren}
      </UnauthorizedBoundary>
    );
  }

  const pageErrorComponent = getErrorBoundaryExport(options.route.error);
  if (pageErrorComponent && options.route.error !== lastLayoutErrorModule) {
    routeChildren = (
      <ErrorBoundary resetKey={routeResetKey} fallback={pageErrorComponent}>
        {routeChildren}
      </ErrorBoundary>
    );
  }

  const renderedTreePositions = isPrefetchLoadingShell
    ? orderedTreePositions.filter(includesPrefetchTreePosition)
    : orderedTreePositions;
  for (let index = renderedTreePositions.length - 1; index >= 0; index--) {
    const treePosition = renderedTreePositions[index];
    const segmentResetKey = resolveAppPageSegmentStateKey(
      routeSegments,
      treePosition,
      options.matchedParams,
    );
    let segmentChildren: ReactNode = routeChildren;
    const layoutEntry = layoutEntriesByTreePosition.get(treePosition);
    const templateEntry = templateEntriesByTreePosition.get(treePosition);
    const loadingEntry = loadingEntriesByTreePosition.get(treePosition);
    const errorEntry = errorEntriesByTreePosition.get(treePosition);

    // The leaf loading convention keeps using the route-level wrapper above so
    // its ordering relative to page access/error boundaries and scroll handling
    // remains unchanged. Ancestor segment boundaries are inserted here so they
    // can suspend while a child layout entry renders.
    if (!isPrefetchLoadingShell && treePosition < routeSegments.length) {
      const segmentLoadingComponent = getDefaultExport(loadingEntry?.loadingModule);
      if (segmentLoadingComponent) {
        const SegmentLoadingComponent = segmentLoadingComponent;
        segmentChildren = (
          <Suspense key={segmentResetKey || routeResetKey} fallback={<SegmentLoadingComponent />}>
            {segmentChildren}
          </Suspense>
        );
      }
    }

    // Next.js nesting per segment (outer to inner): Layout > Template > Error > Unauthorized > Forbidden > NotFound > Loading > children.
    // Building bottom-up means Loading must wrap the leaf subtree first, then
    // access/error boundaries, Template, and finally the Layout slot.
    if (layoutEntry) {
      const layoutNotFoundComponent = getDefaultExport(layoutEntry.notFoundModule);
      if (layoutNotFoundComponent) {
        const LayoutNotFoundComponent = layoutNotFoundComponent;
        segmentChildren = (
          <NotFoundBoundary resetKey={segmentResetKey} fallback={<LayoutNotFoundComponent />}>
            {segmentChildren}
          </NotFoundBoundary>
        );
      }

      const layoutForbiddenComponent = getDefaultExport(layoutEntry.forbiddenModule);
      if (layoutForbiddenComponent) {
        const LayoutForbiddenComponent = layoutForbiddenComponent;
        segmentChildren = (
          <ForbiddenBoundary resetKey={segmentResetKey} fallback={<LayoutForbiddenComponent />}>
            {segmentChildren}
          </ForbiddenBoundary>
        );
      }

      const layoutUnauthorizedComponent = getDefaultExport(layoutEntry.unauthorizedModule);
      if (layoutUnauthorizedComponent) {
        const LayoutUnauthorizedComponent = layoutUnauthorizedComponent;
        segmentChildren = (
          <UnauthorizedBoundary
            resetKey={segmentResetKey}
            fallback={<LayoutUnauthorizedComponent />}
          >
            {segmentChildren}
          </UnauthorizedBoundary>
        );
      }
    }

    const segmentErrorComponent = getErrorBoundaryExport(
      errorEntry?.errorModule ?? layoutEntry?.errorModule,
    );
    if (segmentErrorComponent) {
      segmentChildren = (
        <ErrorBoundary resetKey={segmentResetKey} fallback={segmentErrorComponent}>
          {segmentChildren}
        </ErrorBoundary>
      );
    }

    if (templateEntry && getDefaultExport(templateEntry.templateModule)) {
      segmentChildren = (
        <Slot id={templateEntry.id} key={segmentResetKey}>
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
      children: resolveAppPageLayoutSegmentProviderSegments(
        options.route.childrenRouteSegments ?? routeSegments,
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
      const slotOverride = resolveSlotOverride(slotKey, slotName);
      const hasActiveSlotPage =
        getDefaultExport(slotOverride?.pageModule) !== null || getDefaultExport(slot.page) !== null;
      const shouldPreserveMountedSlot =
        !hasActiveSlotPage &&
        options.isRscRequest &&
        options.mountedSlotIds?.has(resolveAppPageSlotId(slot, layoutEntry.treePath));
      if (shouldPreserveMountedSlot) {
        continue;
      }
      const slotRouteSegments = slotOverride?.routeSegments ?? slot.routeSegments;
      segmentMap[slotName] = slotRouteSegments
        ? resolveAppPageLayoutSegmentProviderSegments(slotRouteSegments, 0, slotParams)
        : [];
    }

    routeChildren = (
      <LayoutSegmentProvider providerId={layoutEntry.id} segmentMap={segmentMap}>
        {layoutHasElement ? (
          <Slot
            id={layoutEntry.id}
            parallelSlots={createAppPageParallelSlotEntries(
              layoutIndex,
              layoutEntries,
              options.route,
              getEffectiveSlotParams,
              resolveSlotOverride,
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
  routeChildren = (
    <GlobalErrorBoundary fallback={DEFAULT_GLOBAL_ERROR_COMPONENT}>
      {globalErrorComponent ? (
        <ErrorBoundary fallback={globalErrorComponent}>{routeChildren}</ErrorBoundary>
      ) : (
        routeChildren
      )}
    </GlobalErrorBoundary>
  );

  elements[routeId] = (
    <>
      {createAppPageRouteHead(
        options.resolvedMetadata,
        options.resolvedViewport,
        options.resolvedMetadataPathname ?? options.routePath,
        metadataPlacement,
        options.trailingSlash,
      )}
      {routeChildren}
      {createAppPageRouteBodyMetadata(
        options.resolvedMetadata,
        options.resolvedMetadataPathname ?? options.routePath,
        metadataPlacement,
        options.trailingSlash,
      )}
      {createAppPageStreamingMetadataBody(streamingMetadataBodyId)}
    </>
  );

  registerAppElementRenderDependencies(elements, renderDependenciesByElementId);
  return elements;
}
