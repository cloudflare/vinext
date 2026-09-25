import { createElement, Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import {
  markAppPagePropsForUseCache,
  withUseCachePageMarker,
} from "vinext/shims/internal/app-page-props-cache-key";
import { isNextRouterError } from "vinext/shims/navigation-server";
import { collectAppPageSearchParams } from "./app-page-head.js";
import {
  probeAppPageComponent,
  probeAppPageLayouts,
  type AppPageSpecialError,
  type LayoutClassificationOptions,
  type LayoutFlags,
} from "./app-page-execution.js";
import { makeObservedAppPageSearchParamsThenable } from "./app-page-search-params-observation.js";
import { SIBLING_PAGE_INTERCEPT_SLOT_KEY } from "./app-rsc-route-matching.js";
import { isPromiseLike } from "../utils/promise.js";
import type { AppPageParams } from "./app-page-boundary.js";
import {
  createAppPageTreePath,
  resolveAppPageSegmentParams,
  resolveInterceptLayoutParams,
  resolveSlotLayoutParams,
} from "./app-page-params.js";
import { createAppElementsWireSlotId } from "./app-elements-wire-key.js";
import {
  createAppPageLoadingEntries,
  createAppPageSlotLoadingEntries,
  getFirstLoadingEntry,
  resolveAppPagePrefetchPlan,
  type AppPageLoadingEntry,
} from "./app-page-prefetch-plan.js";
import type { AppRscRenderMode } from "./app-rsc-render-mode.js";

const DEFAULT_SUBTREE_PROBE_MAX_DEPTH = 32;
const DEFAULT_SUBTREE_PROBE_MAX_NODES = 1000;
const REACT_FORWARD_REF_TYPE = Symbol.for("react.forward_ref");
const REACT_LAZY_TYPE = Symbol.for("react.lazy");
const REACT_MEMO_TYPE = Symbol.for("react.memo");
const REACT_CLIENT_REFERENCE_TYPE = Symbol.for("react.client.reference");

type ProbeReactServerSubtreeOptions = Readonly<{
  maxDepth?: number;
  maxNodes?: number;
}>;

type ProbeReactElementProps = Readonly<{
  children?: ReactNode;
}>;

type UnknownFunction = (...args: unknown[]) => unknown;

type ReactMemoType = Readonly<{
  innerType: unknown;
}>;

type ReactLazyType = Readonly<{
  init: UnknownFunction;
  payload: unknown;
}>;

class AppPageSubtreeProbeLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppPageSubtreeProbeLimitError";
  }
}

class AppPageSubtreeProbeUnsupportedIterableError extends Error {
  constructor() {
    super("App page layout subtree probe cannot safely inspect iterable children");
    this.name = "AppPageSubtreeProbeUnsupportedIterableError";
  }
}

function isIterable(value: unknown): value is Iterable<unknown> {
  return Boolean(
    value &&
    typeof value !== "string" &&
    typeof value === "object" &&
    Symbol.iterator in value &&
    typeof value[Symbol.iterator] === "function",
  );
}

function isProbeReactElement(value: unknown): value is ReactElement<ProbeReactElementProps> {
  return isValidElement<ProbeReactElementProps>(value);
}

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" || typeof value === "function") && value !== null;
}

function isUnknownFunction(value: unknown): value is UnknownFunction {
  return typeof value === "function";
}

function isReactClientReference(value: unknown): boolean {
  return isObjectLike(value) && Reflect.get(value, "$$typeof") === REACT_CLIENT_REFERENCE_TYPE;
}

function readReactMemoType(value: unknown): ReactMemoType | null {
  if (!isObjectLike(value) || Reflect.get(value, "$$typeof") !== REACT_MEMO_TYPE) {
    return null;
  }
  return { innerType: Reflect.get(value, "type") };
}

function readReactLazyType(value: unknown): ReactLazyType | null {
  if (!isObjectLike(value) || Reflect.get(value, "$$typeof") !== REACT_LAZY_TYPE) {
    return null;
  }
  const init = Reflect.get(value, "_init");
  if (!isUnknownFunction(init)) {
    return null;
  }
  return { init, payload: Reflect.get(value, "_payload") };
}

function readReactForwardRefRender(value: unknown): UnknownFunction | null {
  if (!isObjectLike(value) || Reflect.get(value, "$$typeof") !== REACT_FORWARD_REF_TYPE) {
    return null;
  }
  const render = Reflect.get(value, "render");
  return isUnknownFunction(render) ? render : null;
}

async function resolveReactLazyType(lazyType: ReactLazyType): Promise<unknown> {
  try {
    return lazyType.init(lazyType.payload);
  } catch (error) {
    if (!isPromiseLike(error)) {
      throw error;
    }
    await error;
    return lazyType.init(lazyType.payload);
  }
}

/**
 * Invokes server-component children returned by a layout probe so per-layout
 * skip eligibility observes data dependencies created below the layout's
 * immediate function body. The real RSC render remains authoritative; probe
 * failures only make static-layout skip fall back to render-and-send.
 */
export async function probeReactServerSubtree(
  node: unknown,
  options: ProbeReactServerSubtreeOptions = {},
): Promise<void> {
  const maxDepth = options.maxDepth ?? DEFAULT_SUBTREE_PROBE_MAX_DEPTH;
  const maxNodes = options.maxNodes ?? DEFAULT_SUBTREE_PROBE_MAX_NODES;
  let visitedNodes = 0;

  const enterProbeNode = (depth: number): void => {
    if (depth > maxDepth) {
      throw new AppPageSubtreeProbeLimitError("App page layout subtree probe exceeded max depth");
    }
    visitedNodes += 1;
    if (visitedNodes > maxNodes) {
      throw new AppPageSubtreeProbeLimitError("App page layout subtree probe exceeded max nodes");
    }
  };

  const renderElementType = async (
    type: unknown,
    props: ProbeReactElementProps,
    depth: number,
    wrapperDepth = 0,
  ): Promise<boolean> => {
    if (wrapperDepth > maxDepth) {
      throw new AppPageSubtreeProbeLimitError("App page layout subtree probe exceeded max depth");
    }

    if (isReactClientReference(type)) {
      return false;
    }

    if (isUnknownFunction(type)) {
      await visit(type(props), depth + 1);
      return true;
    }

    const memoType = readReactMemoType(type);
    if (memoType) {
      return renderElementType(memoType.innerType, props, depth, wrapperDepth + 1);
    }

    const lazyType = readReactLazyType(type);
    if (lazyType) {
      return renderElementType(
        await resolveReactLazyType(lazyType),
        props,
        depth,
        wrapperDepth + 1,
      );
    }

    const forwardRefRender = readReactForwardRefRender(type);
    if (forwardRefRender) {
      await visit(forwardRefRender(props, null), depth + 1);
      return true;
    }

    return false;
  };

  const visit = async (value: unknown, depth: number): Promise<void> => {
    enterProbeNode(depth);
    if (value == null || typeof value === "boolean" || typeof value === "number") return;
    if (typeof value === "string" || typeof value === "bigint") return;
    if (isPromiseLike(value)) {
      await visit(await value, depth);
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        await visit(child, depth + 1);
      }
      return;
    }
    if (isIterable(value) && !isProbeReactElement(value)) {
      throw new AppPageSubtreeProbeUnsupportedIterableError();
    }
    if (!isProbeReactElement(value)) return;

    if (value.type === Fragment || typeof value.type === "string") {
      await visit(value.props.children, depth + 1);
      return;
    }

    if (await renderElementType(value.type, value.props, depth)) {
      return;
    }

    await visit(value.props.children, depth + 1);
  };

  await visit(node, 0);
}

async function probeReactServerSubtreeForDynamicUsage(node: unknown): Promise<void> {
  try {
    await probeReactServerSubtree(node);
  } catch (error) {
    if (isNextRouterError(error)) {
      return;
    }
    throw error;
  }
}

/**
 * Build a probePage() invocation for the App Router request lifecycle.
 *
 * The generated RSC entry calls this once per request after route matching to
 * eagerly invoke the page component. Surfacing redirect()/notFound() throws
 * here lets the probe lifecycle turn them into proper HTTP responses before
 * RSC streaming begins (see `probeAppPageBeforeRender`).
 *
 * The helper exists to keep the generated entry thin (a single delegation
 * call) and to make the search-params wiring directly unit-testable. A bug
 * here previously slipped through because the entry hand-rolled the call and
 * read a non-existent key off `collectAppPageSearchParams`'s return value
 * (see https://github.com/cloudflare/vinext/issues/1235).
 *
 * Returns `null` when the route has no page component (eg. interception-only
 * routes), matching the caller contract on `probePage`.
 */
export function probeAppPage(options: {
  pageComponent: unknown;
  asyncRouteParams: unknown;
  searchParams: URLSearchParams | null | undefined;
}): unknown {
  const { pageComponent, asyncRouteParams, searchParams } = options;
  if (typeof pageComponent !== "function") {
    return null;
  }
  const { pageSearchParams } = collectAppPageSearchParams(searchParams);
  const asyncSearchParams = makeObservedAppPageSearchParamsThenable(pageSearchParams, {
    observeReactPromiseStatus: true,
  });
  // Match the render path: a "use cache" page component also receives the
  // `$$isPage` marker, so probe and render derive the same cache key.
  const pageProps = markAppPagePropsForUseCache(
    withUseCachePageMarker(pageComponent, {
      params: asyncRouteParams,
      searchParams: asyncSearchParams,
    }),
  );
  const result = (pageComponent as (props: Record<string, unknown>) => unknown)(pageProps);
  if (isPromiseLike(result)) {
    return result.then(async (resolved) => {
      await probeReactServerSubtreeForDynamicUsage(resolved);
      return resolved;
    });
  }
  if (isValidElement(result) || Array.isArray(result)) {
    return probeReactServerSubtreeForDynamicUsage(result).then(() => result);
  }
  return result;
}

type AppPageProbeModule = Readonly<{ default?: unknown }> | null | undefined;

type AppPageProbeSlot =
  | Readonly<{
      name?: string;
      default?: AppPageProbeModule;
      layout?: AppPageProbeModule;
      layoutIndex?: number;
      ownerTreePosition?: number | null;
      page?: AppPageProbeModule;
      loading?: AppPageProbeModule;
      loadings?: readonly AppPageProbeModule[] | null;
      loadingTreePositions?: readonly number[] | null;
      configLayouts?: readonly AppPageProbeModule[] | null;
      configLayoutTreePositions?: readonly number[] | null;
      routeSegments?: readonly string[] | null;
    }>
  | null
  | undefined;

type AppPageProbeRoute = Readonly<{
  layoutTreePositions?: readonly number[] | null;
  routeSegments?: readonly string[] | null;
  slots?: Readonly<Record<string, AppPageProbeSlot>> | null;
}>;

type AppPageProbeIntercept =
  | Readonly<{
      page?: AppPageProbeModule;
      interceptBranchSegments?: readonly string[] | null;
      interceptLayouts?: readonly AppPageProbeModule[] | null;
      interceptLayoutSegments?: readonly (readonly string[])[] | null;
      interceptLoadings?: readonly AppPageProbeModule[] | null;
      interceptLoadingTreePositions?: readonly number[] | null;
      matchedParams?: AppPageParams;
      /**
       * Key of the parallel-route slot this interception overrides. At render
       * time the matched route's `slots[slotKey].page` is replaced by the
       * interception page (see app-page-element-builder.ts), so the slot's own
       * page never renders for this request.
       */
      slotKey?: string | null;
    }>
  | null
  | undefined;

/**
 * The interception a request's probes cover, or null when it renders nothing.
 * A slot intercept whose slot the route doesn't have leaves the route's tree
 * unchanged (the renderer has no slot to put it in), so its page is neither
 * loaded nor probed. A sibling-page intercept replaces the route's page.
 */
export function resolveAppPageProbeIntercept<TIntercept extends AppPageProbeIntercept>(
  route: AppPageProbeRoute,
  intercept: TIntercept,
): TIntercept | null {
  const slotKey = intercept?.slotKey;
  if (
    slotKey &&
    slotKey !== SIBLING_PAGE_INTERCEPT_SLOT_KEY &&
    !(route.slots && Object.hasOwn(route.slots, slotKey))
  ) {
    return null;
  }
  return intercept ?? null;
}

/**
 * Where an active interception renders, as the element builder places it: in
 * place of the page for a sibling-page intercept, or in the slot it names.
 * Null when the route has no such slot, which keeps its own tree unchanged
 * (buildSlotOverrides, resolveAppPageInterceptTree).
 */
function resolveAppPageInterceptPlacement(
  route: AppPageProbeRoute,
  intercept: AppPageProbeIntercept,
):
  | { kind: "page" }
  | { kind: "slot"; slotKey: string; slot: NonNullable<AppPageProbeSlot> }
  | null {
  if (!intercept?.slotKey) return null;
  if (intercept.slotKey === SIBLING_PAGE_INTERCEPT_SLOT_KEY) return { kind: "page" };
  const slot = route.slots?.[intercept.slotKey];
  return slot ? { kind: "slot", slotKey: intercept.slotKey, slot } : null;
}

/**
 * Fan out the per-request page probes for the App Router dispatch lifecycle.
 *
 * A single request can render more than one page component: the matched page,
 * each active parallel-route slot page, and an interception page when one
 * matches. Each must be probed so searchParams access anywhere in the rendered
 * tree bails the request out of the query-invariant static cache.
 *
 * Extracted out of the generated RSC entry so the fan-out is directly
 * unit-testable and the entry stays codegen glue (see AGENTS.md "Generated
 * Entry Modules Should Stay Thin"). Returns a list of resolved promises so the
 * caller can `Promise.all` them.
 *
 * The fan-out is scoped to the page components that render for this request,
 * as the element builder and route wiring select them:
 *
 * - **Interception:** a matched interception renders in place of the page for
 *   a sibling-page intercept, or replaces the page of the slot named by
 *   `intercept.slotKey` (`buildSlotOverrides`). We probe the interception page
 *   in place of what it replaces rather than probing both, since probing a
 *   component that never renders would mark an otherwise-static request
 *   dynamic. A route without the named slot renders unchanged, so its
 *   interception isn't probed.
 * - **Other slots:** `slot.page?.default` is exactly what renders when the
 *   slot has a page. A default-only slot probes nothing — a no-op, not an
 *   over-bail.
 *
 * Interception only fires for RSC navigations (`resolveAppPageInterceptState`
 * returns `kind: "none"` when `!isRscRequest`), so the interception handling
 * here is gated on `isRscRequest`. For non-RSC (HTML) requests the matched
 * route renders normally, so we probe every slot's own page and skip the
 * interception probe entirely. The matched route's probe sees the
 * current-route override case; a direct intercepted RSC response probes the
 * source route that it renders with `buildAppPageInterceptSourceProbes`.
 *
 * A `default.tsx` that itself awaits `searchParams` is not probed here, but the
 * real render still observes that access and skips the query-invariant cache
 * write (the same loading.tsx backstop), so this cannot under-bail.
 */
export function buildAppPageProbes(options: {
  route: AppPageProbeRoute;
  pageComponent: unknown;
  asyncRouteParams: unknown;
  searchParams: URLSearchParams | null | undefined;
  intercept?: AppPageProbeIntercept;
  /**
   * Whether this is an RSC navigation. Interception only fires for RSC
   * requests, so the interception probe is ignored when this is false.
   */
  isRscRequest: boolean;
  /** Fallback raw params used when an interception match omits its own. */
  matchedParams: unknown;
  makeThenableParams: (params: unknown) => unknown;
}): Promise<unknown>[] {
  const { route, pageComponent, asyncRouteParams, searchParams, matchedParams } = options;

  // Interception only fires for RSC navigations; on HTML requests the matched
  // route renders normally, so ignore any interception match entirely.
  const intercept = options.isRscRequest ? options.intercept : null;
  const placement = resolveAppPageInterceptPlacement(route, intercept);

  // A sibling-page intercept's page (probed below) renders in place of this one.
  const probes: unknown[] =
    placement?.kind === "page"
      ? []
      : [probeAppPage({ pageComponent, asyncRouteParams, searchParams })];

  // A slot whose page is replaced by an active interception override does not
  // render its own `page.tsx`; the interception page (probed below) renders in
  // its place, so skip the overridden slot to avoid a false dynamic bailout.
  const overriddenSlotKey = placement?.kind === "slot" ? placement.slotKey : null;

  for (const [slotKey, slot] of Object.entries(route.slots ?? {})) {
    if (overriddenSlotKey !== null && slotKey === overriddenSlotKey) {
      continue;
    }
    if (slot?.loading?.default || slot?.loadings?.some((loading) => loading?.default)) {
      continue;
    }
    probes.push(
      probeAppPage({
        pageComponent: slot?.page?.default,
        asyncRouteParams,
        searchParams,
      }),
    );
  }

  const interceptedSlot = placement?.kind === "slot" ? placement.slot : null;
  const interceptedSlotHasRootLoading = Boolean(
    interceptedSlot?.loading?.default ||
    interceptedSlot?.loadings?.some(
      (loading, index) => loading?.default && interceptedSlot.loadingTreePositions?.[index] === 0,
    ),
  );
  const interceptHasLoadingBoundary = Boolean(
    intercept?.interceptLoadings?.some((loading) => loading?.default) ||
    interceptedSlotHasRootLoading,
  );
  if (intercept && placement && !interceptHasLoadingBoundary) {
    probes.push(
      probeAppPage({
        pageComponent: intercept.page?.default,
        asyncRouteParams: options.makeThenableParams(intercept.matchedParams ?? matchedParams),
        searchParams,
      }),
    );
  }

  return probes.map((probe) => Promise.resolve(probe));
}

type AppPageInterceptSourceProbeRoute = AppPageProbeRoute &
  Readonly<{
    layouts?: readonly AppPageProbeModule[] | null;
    loading?: AppPageProbeModule;
    loadings?: readonly AppPageProbeModule[] | null;
    loadingTreePositions?: readonly number[] | null;
    templates?: readonly AppPageProbeModule[] | null;
    templateTreePositions?: readonly number[] | null;
  }>;

type AppPageProbedLayout = {
  layoutModule: AppPageProbeModule;
  /** Null for a template, which gets only its children. */
  params: AppPageParams | null;
  treePosition: number;
};

function ignoreProbeOutcome(): void {}

/**
 * Probes what a direct intercepted RSC response renders ahead of its loading
 * boundaries, since it sets its headers before its render: the source route's
 * layouts and templates, its page (or a sibling-page intercept's layouts and
 * page), each parallel slot's layout chain and page or default, and the first
 * loading component each of those branches renders as its fallback, with the
 * intercepting branch in the slot it intercepts. What renders follows route
 * wiring (app-page-route-wiring.tsx), including the render mode's prefetch
 * plan (a loading-shell prefetch's selected route and slot loading components
 * take the pages' place) and the default-only slots the client keeps mounted,
 * and each component gets the params the rendered tree passes it.
 *
 * Each probe settles without rejecting: the response's own render surfaces
 * special errors and other failures.
 */
export function buildAppPageInterceptSourceProbes(options: {
  route: AppPageInterceptSourceProbeRoute;
  pageComponent: unknown;
  intercept?: AppPageProbeIntercept;
  /** The source route's params, which the intercepted render passes its tree. */
  sourceParams: AppPageParams;
  /**
   * The params an inherited slot renders with in place of `sourceParams`,
   * by slot key, as `resolveSlotParamOverrides` matches them for the request.
   */
  slotParamOverrides?: Readonly<Record<string, AppPageParams>> | null;
  searchParams: URLSearchParams | null | undefined;
  mountedSlotsHeader: string | null | undefined;
  renderMode: AppRscRenderMode | undefined;
  makeThenableParams: (params: unknown) => unknown;
}): Promise<void>[] {
  const { route, intercept, sourceParams, searchParams, makeThenableParams } = options;
  const placement = resolveAppPageInterceptPlacement(route, intercept);
  const interceptedSlotOverride =
    placement?.kind === "slot"
      ? {
          loadingModules: intercept?.interceptLoadings,
          loadingTreePositions: intercept?.interceptLoadingTreePositions,
        }
      : null;
  const resolveSlotOverride = (slotKey: string) =>
    placement?.kind === "slot" && slotKey === placement.slotKey ? interceptedSlotOverride : null;
  const prefetchPlan = resolveAppPagePrefetchPlan({
    renderMode: options.renderMode,
    resolveSlotOverride,
    route,
  });
  if (prefetchPlan.isPrefetchEmpty) return [];

  const probes: Promise<void>[] = [];
  const probe = (run: () => unknown) => {
    probes.push(Promise.resolve().then(run).then(ignoreProbeOutcome, ignoreProbeOutcome));
  };
  // Like the layout probes, stop at a loading boundary: what's below it
  // streams behind its fallback, after the response headers.
  const probeLayoutsAbove = (
    layouts: readonly AppPageProbedLayout[],
    loadingTreePosition: number,
  ) => {
    for (const { layoutModule, params, treePosition } of layouts) {
      const LayoutComponent = layoutModule?.default;
      if (typeof LayoutComponent !== "function" || treePosition > loadingTreePosition) continue;
      probe(() =>
        probeReactServerSubtree(
          createElement(
            LayoutComponent as (props: { params?: unknown }) => ReactNode,
            params ? { params: makeThenableParams(params) } : null,
            createElement(Fragment),
          ),
        ),
      );
    }
  };
  const firstLoadingTreePosition = (entries: readonly AppPageLoadingEntry[]) =>
    getFirstLoadingEntry(entries)?.treePosition ?? Infinity;
  // A loading-shell prefetch renders its selected loading components directly,
  // in place of the page or slot page they'd wrap. Otherwise each branch's
  // first loading component renders as its Suspense fallback, ahead of what
  // that boundary wraps.
  const probeLoading = (entry: AppPageLoadingEntry | null) => {
    const LoadingComponent = entry?.loadingModule?.default;
    if (typeof LoadingComponent !== "function") return;
    probe(() => probeReactServerSubtree(createElement(LoadingComponent as () => ReactNode)));
  };

  const routeLoadingEntries = createAppPageLoadingEntries(route).filter(
    (entry) => entry.loadingModule?.default,
  );
  // Legacy/eager route fixtures may only expose the leaf loading field.
  if (routeLoadingEntries.length === 0 && route.loading?.default) {
    routeLoadingEntries.push({
      loadingModule: route.loading,
      treePosition: route.routeSegments?.length ?? 0,
    });
  }
  const routeLoadingTreePosition = firstLoadingTreePosition(routeLoadingEntries);
  const routeLayouts: AppPageProbedLayout[] = [];
  for (const [index, layoutModule] of (route.layouts ?? []).entries()) {
    const treePosition = route.layoutTreePositions?.[index] ?? 0;
    routeLayouts.push({
      layoutModule,
      params: resolveAppPageSegmentParams(route.routeSegments, treePosition, sourceParams),
      treePosition,
    });
  }
  for (const [index, layoutModule] of (route.templates ?? []).entries()) {
    routeLayouts.push({
      layoutModule,
      params: null,
      treePosition: route.templateTreePositions?.[index] ?? 0,
    });
  }
  // A loading-shell prefetch renders no route Suspense boundary, only the
  // layouts down to its cutoff and the loading UI selected there.
  probeLayoutsAbove(
    routeLayouts.filter(({ treePosition }) => prefetchPlan.includesTreePosition(treePosition)),
    prefetchPlan.isPrefetchLoadingShell ? Infinity : routeLoadingTreePosition,
  );
  probeLoading(
    prefetchPlan.isPrefetchLoadingShell
      ? prefetchPlan.prefetchLoadingEntry
      : getFirstLoadingEntry(routeLoadingEntries),
  );

  // Every route loading boundary wraps the page, which a loading-shell
  // prefetch omits.
  if (routeLoadingTreePosition === Infinity && !prefetchPlan.isPrefetchLoadingShell) {
    if (placement?.kind === "page") {
      // The intercepting page and its layouts take the source page's place.
      const interceptParams = intercept?.matchedParams ?? sourceParams;
      const interceptLoadingEntries = (intercept?.interceptLoadings ?? []).flatMap(
        (loadingModule, index) => {
          const treePosition = intercept?.interceptLoadingTreePositions?.[index];
          return loadingModule?.default && treePosition !== undefined
            ? [{ loadingModule, treePosition }]
            : [];
        },
      );
      probeLayoutsAbove(
        (intercept?.interceptLayouts ?? []).map((layoutModule, index) => {
          const layoutSegments = intercept?.interceptLayoutSegments?.[index] ?? [];
          return {
            layoutModule,
            params: resolveInterceptLayoutParams(
              intercept?.interceptBranchSegments ?? layoutSegments,
              layoutSegments,
              interceptParams,
            ),
            treePosition: layoutSegments.length,
          };
        }),
        firstLoadingTreePosition(interceptLoadingEntries),
      );
      probeLoading(getFirstLoadingEntry(interceptLoadingEntries));
      if (interceptLoadingEntries.length === 0) {
        probe(() =>
          probeAppPage({
            pageComponent: intercept?.page?.default,
            asyncRouteParams: makeThenableParams(interceptParams),
            searchParams,
          }),
        );
      }
    } else {
      probe(() =>
        probeAppPage({
          pageComponent: options.pageComponent,
          asyncRouteParams: makeThenableParams(sourceParams),
          searchParams,
        }),
      );
    }
  }

  const mountedSlotIds = options.mountedSlotsHeader
    ? new Set(options.mountedSlotsHeader.split(" "))
    : null;
  const layoutTreePositions = route.layoutTreePositions ?? [];
  for (const [slotKey, slot] of Object.entries(route.slots ?? {})) {
    if (!slot) continue;
    const targetIndex =
      (slot.layoutIndex ?? -1) >= 0 ? slot.layoutIndex! : layoutTreePositions.length - 1;
    const targetTreePosition = layoutTreePositions[targetIndex] ?? 0;
    const ownerTreePosition = slot.ownerTreePosition ?? targetTreePosition;
    if (!prefetchPlan.includesSlot(ownerTreePosition, targetTreePosition)) continue;
    // A route loading boundary at or above the slot's owner wraps the whole
    // slot, except in a loading-shell prefetch.
    if (!prefetchPlan.isPrefetchLoadingShell && routeLoadingTreePosition <= ownerTreePosition) {
      continue;
    }
    const isIntercepted = placement?.kind === "slot" && placement.slotKey === slotKey;
    const pageComponent =
      (isIntercepted ? intercept?.page?.default : undefined) ?? slot.page?.default;
    const defaultComponent = slot.default?.default;
    const slotId =
      slot.name === undefined
        ? null
        : createAppElementsWireSlotId(
            slot.name,
            createAppPageTreePath(route.routeSegments, targetTreePosition),
          );
    // The payload leaves out a default-only slot the client keeps mounted.
    if (!pageComponent && (!defaultComponent || (slotId && mountedSlotIds?.has(slotId)))) {
      continue;
    }

    const slotLoadingEntries = createAppPageSlotLoadingEntries(
      slot,
      isIntercepted ? interceptedSlotOverride : null,
    );
    let slotLoadingTreePosition = firstLoadingTreePosition(slotLoadingEntries);
    if (prefetchPlan.isPrefetchLoadingShell) {
      // The shell renders a loading boundary in place of the slot's page.
      const shellLoading = prefetchPlan.resolveSlotLoadingEntry(
        ownerTreePosition,
        slotLoadingEntries,
      );
      if (!shellLoading.entry) continue;
      slotLoadingTreePosition = shellLoading.isOwnedAtRoutePrefetchCutoff
        ? -1
        : shellLoading.entry.treePosition;
      // The route's loading UI, when the slot is owned at its cutoff, is
      // already probed above.
      if (!shellLoading.isOwnedAtRoutePrefetchCutoff) probeLoading(shellLoading.entry);
    } else {
      probeLoading(getFirstLoadingEntry(slotLoadingEntries));
    }

    const slotOwnerParams = resolveAppPageSegmentParams(
      route.routeSegments,
      targetTreePosition,
      sourceParams,
    );
    const slotParams = isIntercepted
      ? (intercept?.matchedParams ?? sourceParams)
      : (options.slotParamOverrides?.[slotKey] ?? sourceParams);
    // The slot's own layout wraps its page, not its default.
    const slotLayouts: AppPageProbedLayout[] = pageComponent
      ? [{ layoutModule: slot.layout, params: slotOwnerParams, treePosition: 0 }]
      : [];
    if (isIntercepted) {
      const branchSegments = intercept?.interceptBranchSegments ?? [];
      for (const [index, layoutModule] of (intercept?.interceptLayouts ?? []).entries()) {
        const treePosition =
          intercept?.interceptLayoutSegments?.[index]?.length ?? branchSegments.length;
        slotLayouts.push({
          layoutModule,
          params: resolveSlotLayoutParams(branchSegments, treePosition, slotParams),
          treePosition,
        });
      }
    } else {
      for (const [index, layoutModule] of (slot.configLayouts ?? []).entries()) {
        const treePosition = slot.configLayoutTreePositions?.[index] ?? 0;
        slotLayouts.push({
          layoutModule,
          params: {
            ...slotOwnerParams,
            ...resolveSlotLayoutParams(slot.routeSegments ?? [], treePosition, slotParams),
          },
          treePosition,
        });
      }
    }
    probeLayoutsAbove(slotLayouts, slotLoadingTreePosition);
    if (slotLoadingTreePosition === Infinity) {
      probe(() =>
        probeAppPage({
          pageComponent: pageComponent ?? defaultComponent,
          asyncRouteParams: makeThenableParams(slotParams),
          searchParams,
        }),
      );
    }
  }

  return probes;
}

type ProbeAppPageBeforeRenderResult = {
  response: Response | null;
  layoutFlags: LayoutFlags;
};

type ProbeAppPageBeforeRenderOptions = {
  hasLoadingBoundary: boolean;
  probePageBeforeRender?: boolean;
  skipProbes?: boolean;
  layoutCount: number;
  probeLayoutAt: (layoutIndex: number) => unknown;
  probePage: () => unknown;
  renderLayoutSpecialError: (
    specialError: AppPageSpecialError,
    layoutIndex: number,
  ) => Promise<Response>;
  renderPageSpecialError: (specialError: AppPageSpecialError) => Promise<Response>;
  resolveSpecialError: (error: unknown) => AppPageSpecialError | null;
  runWithSuppressedHookWarning<T>(probe: () => Promise<T>): Promise<T>;
  /** When provided, enables per-layout static/dynamic classification. */
  classification?: LayoutClassificationOptions | null;
};

export async function probeAppPageBeforeRender(
  options: ProbeAppPageBeforeRenderOptions,
): Promise<ProbeAppPageBeforeRenderResult> {
  let layoutFlags: LayoutFlags = {};

  if (options.skipProbes) {
    return { response: null, layoutFlags };
  }

  // Layouts render before their children in Next.js, so layout-level special
  // errors must be handled before probing the page component itself.
  if (options.layoutCount > 0) {
    const layoutProbeResult = await probeAppPageLayouts({
      layoutCount: options.layoutCount,
      async onLayoutError(layoutError, layoutIndex) {
        const specialError = options.resolveSpecialError(layoutError);
        if (!specialError) {
          return null;
        }

        return options.renderLayoutSpecialError(specialError, layoutIndex);
      },
      probeLayoutAt: options.probeLayoutAt,
      runWithSuppressedHookWarning(probe) {
        return options.runWithSuppressedHookWarning(probe);
      },
      classification: options.classification,
    });

    layoutFlags = layoutProbeResult.layoutFlags;

    if (layoutProbeResult.response) {
      return { response: layoutProbeResult.response, layoutFlags };
    }
  }

  // When a route-level loading.tsx is present, the page renders inside a
  // route-level Suspense boundary, so a thrown redirect()/notFound() during
  // page render becomes an error inside that boundary. We can't catch it
  // here without serializing on the page promise — which would defeat the
  // streaming benefit of loading.tsx for slow non-redirecting pages.
  //
  // Recovery for the redirect/notFound case happens later in
  // renderAppPageLifecycle: rscErrorTracker captures the digest from React's
  // onError callback, and a short race window after shell-ready lets the
  // lifecycle swap the response to a 307/404 before bytes are flushed.
  // This mirrors Next.js's "until-first-byte-is-flushed" swap behavior.
  if (options.hasLoadingBoundary || options.probePageBeforeRender === false) {
    return { response: null, layoutFlags };
  }

  // Server Components are functions, so we can probe the page ahead of stream
  // creation and only turn special throws into immediate responses.
  const pageResponse = await probeAppPageComponent({
    awaitAsyncResult: true,
    async onError(pageError) {
      const specialError = options.resolveSpecialError(pageError);
      if (specialError) {
        return options.renderPageSpecialError(specialError);
      }

      // Non-special probe failures (for example use() outside React's render
      // cycle or client references executing on the server) are expected here.
      // The real RSC/SSR render path will surface those properly below.
      return null;
    },
    probePage: options.probePage,
    runWithSuppressedHookWarning(probe) {
      return options.runWithSuppressedHookWarning(probe);
    },
  });

  return { response: pageResponse, layoutFlags };
}
