import {
  NEXT_ROUTER_SEGMENT_PREFETCH_HEADER,
  NEXTJS_DEPLOYMENT_ID_HEADER,
  RSC_HEADER,
  NEXT_ROUTER_PREFETCH_HEADER,
} from "./headers.js";
import {
  VINEXT_RSC_CONTENT_TYPE,
  VINEXT_RSC_VARY_HEADER,
  applyRscCompatibilityIdHeader,
} from "./app-rsc-cache-busting.js";
import { getDeploymentId } from "../utils/deployment-id.js";
import { AppElementsWire, APP_DYNAMIC_STALE_TIME_KEY } from "./app-elements.js";

const PARENT_INLINED_INTO_SELF = 0b100000;
const INLINED_INTO_CHILD = 0b1000000;
const HEAD_INLINED_INTO_SELF = 0b10000000;
const HEAD_OUTLINED = 0b100000000;

const PAGE_SEGMENT = "__PAGE__";
const SLOT_SEGMENT = "(__SLOT__)";
const SEGMENT_INLINE_SIZE = 1;
const DEFAULT_SEGMENT_INLINE_THRESHOLD = 2048;
const HEAD_INLINE_SIZE = 1;
const DEFAULT_MAX_INLINE_BUNDLE_SIZE = 10240;
const NEXT_DID_POSTPONE_HEADER = "x-nextjs-postponed";

type DynamicParamTypeShort = "d" | "c" | "oc";

type TreePrefetchParam = {
  type: DynamicParamTypeShort;
  key: null;
  siblings: readonly string[] | null;
};

type AppRouteTreePrefetchSlot = {
  configLayouts?: readonly unknown[] | null;
  configLayoutTreePositions?: readonly number[] | null;
  default?: unknown;
  layout?: unknown;
  layoutIndex?: number;
  name: string;
  page?: unknown;
  routeSegments?: readonly string[] | null;
};

export type AppRouteTreePrefetchRoute = {
  layoutTreePositions?: readonly number[];
  layouts?: readonly unknown[];
  page?: unknown;
  pattern?: string;
  routeSegments: readonly string[];
  slots?: Readonly<Record<string, AppRouteTreePrefetchSlot>> | null;
};

export type TreePrefetch = {
  name: string;
  param: TreePrefetchParam | null;
  prefetchHints: number;
  slots: null | Record<string, TreePrefetch>;
};

type RouteTreePrefetchResponseOptions = {
  buildId?: string | null;
  deploymentId?: string;
  measuredSizes?: AppRouteTreePrefetchSizes;
  prefetchInlining?: PrefetchInliningConfig;
};

export type PrefetchInliningConfig =
  | false
  | {
      maxBundleSize: number;
      maxSize: number;
    };

type ResolvedPrefetchInliningConfig = Exclude<PrefetchInliningConfig, false>;

type MutableTreePrefetch = TreePrefetch & {
  prefetchSize: number | null;
  slots: null | Record<string, MutableTreePrefetch>;
};

export type AppRouteTreePrefetchSizes = {
  head: number | null;
  layouts: readonly (number | null)[];
  page: number | null;
  /** Flattened parallel-slot payloads keyed by their full wire slot id. */
  slots: Readonly<Record<string, number | null>>;
};

type AppRouteTreePrefetchRenderer = (
  model: unknown,
) => ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>;

type AppRouteTreePrefetchMeasurementOptions = {
  buildId?: string | null;
  head?: unknown;
  isPartial?: boolean;
  staleTime?: number;
  varyParams?: ReadonlySet<string> | null;
};

export function isRouteTreePrefetchRequest(request: Request): boolean {
  return (
    request.headers.get(RSC_HEADER) === "1" &&
    request.headers.get(NEXT_ROUTER_PREFETCH_HEADER) === "1" &&
    request.headers.get(NEXT_ROUTER_SEGMENT_PREFETCH_HEADER) === "/_tree"
  );
}

function createNode(
  segment: string,
  module: unknown,
  measuredSize?: number | null,
): MutableTreePrefetch {
  const { name, param } = routeTreeSegment(segment);
  const estimatedSize = estimatePrefetchSize(module);
  const virtualSegmentSize =
    (module === null || module === undefined) && segment !== PAGE_SEGMENT
      ? SEGMENT_INLINE_SIZE
      : null;
  return {
    name,
    param,
    prefetchSize: measuredSize !== undefined ? measuredSize : (estimatedSize ?? virtualSegmentSize),
    prefetchHints: 0,
    slots: null,
  };
}

function ensureSlots(node: MutableTreePrefetch): Record<string, MutableTreePrefetch> {
  if (node.slots === null) {
    node.slots = {};
  }
  return node.slots;
}

function addChild(node: MutableTreePrefetch, key: string, child: MutableTreePrefetch): void {
  ensureSlots(node)[key] = child;
}

function routeTreeSegment(segment: string): { name: string; param: TreePrefetchParam | null } {
  if (segment.startsWith(":")) {
    const rest = segment.slice(1);
    if (rest.endsWith("+")) {
      return dynamicRouteTreeSegment(rest.slice(0, -1), "c");
    }
    if (rest.endsWith("*")) {
      return dynamicRouteTreeSegment(rest.slice(0, -1), "oc");
    }
    return dynamicRouteTreeSegment(rest, "d");
  }
  if (segment.startsWith("[[...") && segment.endsWith("]]")) {
    return dynamicRouteTreeSegment(segment.slice(5, -2), "oc");
  }
  if (segment.startsWith("[...") && segment.endsWith("]")) {
    return dynamicRouteTreeSegment(segment.slice(4, -1), "c");
  }
  if (segment.startsWith("[") && segment.endsWith("]")) {
    return dynamicRouteTreeSegment(segment.slice(1, -1), "d");
  }
  return { name: segment, param: null };
}

function dynamicRouteTreeSegment(
  name: string,
  type: DynamicParamTypeShort,
): { name: string; param: TreePrefetchParam } {
  return {
    name,
    param: {
      key: null,
      // Next.js emits segment-local static siblings on each loader-tree dynamic
      // segment. Vinext currently only has the flattened full-RSC-payload list,
      // so route-tree prefetches leave this unknown until segment-local route
      // metadata exists.
      siblings: null,
      type,
    },
  };
}

function estimatePrefetchSize(module: unknown): number | null {
  if (typeof module !== "object" || module === null) return null;
  const Component = (module as { default?: unknown }).default;
  return typeof Component === "function" ? SEGMENT_INLINE_SIZE : null;
}

function layoutModuleByTreePosition(route: AppRouteTreePrefetchRoute): Map<number, unknown> {
  const layouts = route.layouts ?? [];
  const positions = route.layoutTreePositions ?? [];
  const byPosition = new Map<number, unknown>();
  for (const [index, position] of positions.entries()) {
    byPosition.set(position, layouts[index]);
  }
  return byPosition;
}

function modulesByTreePosition<T>(
  modules: readonly T[] | null | undefined,
  positions: readonly number[] | null | undefined,
): Map<number, T | undefined> {
  const byPosition = new Map<number, T | undefined>();
  for (const [index, position] of (positions ?? []).entries()) {
    byPosition.set(position, modules?.[index]);
  }
  return byPosition;
}

async function buildTree(
  route: AppRouteTreePrefetchRoute,
  measuredSizes?: AppRouteTreePrefetchSizes,
): Promise<MutableTreePrefetch> {
  const layoutsByPosition = layoutModuleByTreePosition(route);
  const layoutSizesByPosition = modulesByTreePosition(
    measuredSizes?.layouts,
    route.layoutTreePositions,
  );
  const measured = measuredSizes !== undefined;
  const root = createNode(
    "",
    layoutsByPosition.get(0),
    measured && layoutSizesByPosition.has(0) ? (layoutSizesByPosition.get(0) ?? null) : undefined,
  );
  const nodesByPosition = new Map<number, MutableTreePrefetch>([[0, root]]);
  let current = root;

  for (const [index, segment] of route.routeSegments.entries()) {
    const position = index + 1;
    const child = createNode(
      segment,
      layoutsByPosition.get(position),
      measured && layoutSizesByPosition.has(position)
        ? (layoutSizesByPosition.get(position) ?? null)
        : undefined,
    );
    addChild(current, "children", child);
    nodesByPosition.set(position, child);
    current = child;
  }

  addChild(
    current,
    "children",
    createNode(PAGE_SEGMENT, route.page, measured ? (measuredSizes.page ?? null) : undefined),
  );

  for (const slot of Object.values(route.slots ?? {})) {
    const ownerPosition =
      slot.layoutIndex === undefined || slot.layoutIndex < 0
        ? route.routeSegments.length
        : (route.layoutTreePositions?.[slot.layoutIndex] ?? route.routeSegments.length);
    const owner = nodesByPosition.get(ownerPosition) ?? current;
    const ownerTreePathSegments = route.routeSegments.slice(0, ownerPosition);
    const ownerTreePath = ownerTreePathSegments.length
      ? `/${ownerTreePathSegments.join("/")}`
      : "/";
    const slotId = AppElementsWire.encodeSlotId(slot.name, ownerTreePath);
    // Vinext's Flight wire format flattens a parallel branch into one entry.
    // Treat intermediate slot segments as unknown instead of attributing the
    // aggregate bytes to the synthetic slot root. The aggregate is assigned
    // to the leaf below, which avoids false inlining decisions and preserves
    // full slot identity when names repeat at different tree paths.
    const slotRoot = createNode(
      SLOT_SEGMENT,
      slot.layout,
      measured && slot.layout != null ? null : undefined,
    );
    let slotCurrent = slotRoot;
    const slotConfigLayoutsByPosition = modulesByTreePosition(
      slot.configLayouts,
      slot.configLayoutTreePositions,
    );
    const slotRouteSegments = slot.routeSegments ?? [];
    for (const [index, segment] of slotRouteSegments.entries()) {
      const position = index + 1;
      const child = createNode(
        segment,
        slotConfigLayoutsByPosition.get(position),
        measured && slotConfigLayoutsByPosition.has(position) ? null : undefined,
      );
      addChild(slotCurrent, "children", child);
      slotCurrent = child;
    }
    addChild(
      slotCurrent,
      "children",
      createNode(
        PAGE_SEGMENT,
        slot.page ?? slot.default,
        measured ? (measuredSizes.slots[slotId] ?? null) : undefined,
      ),
    );
    addChild(owner, slot.name, slotRoot);
  }

  return root;
}

async function gzipSize(stream: ReadableStream<Uint8Array>): Promise<number> {
  const bytes = await new Response(stream).arrayBuffer();
  const compressed = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return (await new Response(compressed).arrayBuffer()).byteLength;
}

async function measurePrefetchModel(
  value: unknown,
  render: AppRouteTreePrefetchRenderer,
  options: AppRouteTreePrefetchMeasurementOptions,
): Promise<number | null> {
  if (value === null || value === undefined) return null;
  const stream = await render({
    ...(options.buildId ? { buildId: options.buildId } : {}),
    rsc: value,
    isPartial: options.isPartial ?? false,
    staleTime: options.staleTime ?? -1,
    varyParams: options.varyParams ?? null,
  });
  return gzipSize(stream);
}

/**
 * Measure the already-rendered App Router Flight entries used by segment
 * prefetches. The input is decoded from the concrete prerender payload, so
 * this pass re-encodes cached React nodes rather than executing user modules.
 */
export async function measureAppRouteTreePrefetchSizes(
  value: unknown,
  render: AppRouteTreePrefetchRenderer,
  options: AppRouteTreePrefetchMeasurementOptions = {},
): Promise<AppRouteTreePrefetchSizes> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { head: null, layouts: [], page: null, slots: {} };
  }

  const elements = value as Record<string, unknown>;
  const carriedStaleTime = elements[APP_DYNAMIC_STALE_TIME_KEY];
  const measurementOptions = {
    ...options,
    staleTime:
      options.staleTime ??
      (typeof carriedStaleTime === "number" && Number.isFinite(carriedStaleTime)
        ? carriedStaleTime
        : -1),
  };
  const layoutIds = Array.isArray(elements.__layoutIds)
    ? elements.__layoutIds.filter((id): id is string => typeof id === "string")
    : [];
  const layouts = await Promise.all(
    layoutIds.map((layoutId) =>
      measurePrefetchModel(elements[layoutId], render, measurementOptions),
    ),
  );

  let pageValue: unknown;
  let childrenSlotPageMeasurement: Promise<number | null> | undefined;
  const slots: Record<string, number | null> = {};
  const slotTasks: Promise<void>[] = [];
  for (const [key, element] of Object.entries(elements)) {
    const parsed = AppElementsWire.parseElementKey(key);
    if (parsed?.kind === "page" && pageValue === undefined) {
      pageValue = element;
    } else if (parsed?.kind === "slot") {
      const measurement = measurePrefetchModel(element, render, measurementOptions);
      if (parsed.name === "children" && childrenSlotPageMeasurement === undefined) {
        childrenSlotPageMeasurement = measurement;
      }
      slots[key] = null;
      slotTasks.push(
        measurement.then((size) => {
          slots[key] = size;
        }),
      );
    }
  }
  const pageMeasurement =
    pageValue === undefined
      ? (childrenSlotPageMeasurement ?? Promise.resolve(null))
      : measurePrefetchModel(pageValue, render, measurementOptions);
  const [page, head] = await Promise.all([
    pageMeasurement,
    measurePrefetchModel(options.head, render, measurementOptions),
    ...slotTasks,
  ]);

  return { head, layouts, page, slots };
}

function isTreePrefetch(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): value is TreePrefetch {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const node = value as Record<string, unknown>;
  const param = node.param;
  const validParam =
    param === null ||
    (typeof param === "object" &&
      !Array.isArray(param) &&
      param !== null &&
      ((param as Record<string, unknown>).type === "d" ||
        (param as Record<string, unknown>).type === "c" ||
        (param as Record<string, unknown>).type === "oc") &&
      (param as Record<string, unknown>).key === null &&
      ((param as Record<string, unknown>).siblings === null ||
        (Array.isArray((param as Record<string, unknown>).siblings) &&
          ((param as Record<string, unknown>).siblings as unknown[]).every(
            (sibling) => typeof sibling === "string",
          ))));
  if (
    typeof node.name !== "string" ||
    typeof node.prefetchHints !== "number" ||
    !Number.isSafeInteger(node.prefetchHints) ||
    node.prefetchHints < 0 ||
    !validParam ||
    (node.slots !== null && (typeof node.slots !== "object" || Array.isArray(node.slots)))
  ) {
    return false;
  }
  return (
    node.slots === null ||
    Object.values(node.slots as Record<string, unknown>).every((child) =>
      isTreePrefetch(child, seen),
    )
  );
}

function getPrecomputedTree(route: AppRouteTreePrefetchRoute): TreePrefetch | null {
  if (typeof route.pattern !== "string") return null;
  const tree = globalThis.__VINEXT_PREFETCH_HINTS__?.[route.pattern];
  return isTreePrefetch(tree) ? tree : null;
}

function computePrefetchHints(
  node: MutableTreePrefetch,
  parentGzipSize: number | null,
  headGzipSize: number | null,
  headInlineState: { inlined: boolean },
  config: ResolvedPrefetchInliningConfig,
): number {
  const currentGzipSize = node.prefetchSize;
  const sizeToInline =
    currentGzipSize !== null && currentGzipSize < config.maxSize ? currentGzipSize : null;

  let didInlineIntoChild = false;
  let acceptingChildInlinedBytes = 0;
  let smallestChildInlinedBytes = Number.POSITIVE_INFINITY;
  let hasChildren = false;

  for (const child of Object.values(node.slots ?? {})) {
    hasChildren = true;
    const childParentSize = didInlineIntoChild ? null : sizeToInline;
    const childInlinedBytes = computePrefetchHints(
      child,
      childParentSize,
      headGzipSize,
      headInlineState,
      config,
    );

    if ((child.prefetchHints & PARENT_INLINED_INTO_SELF) !== 0) {
      didInlineIntoChild = true;
      acceptingChildInlinedBytes = childInlinedBytes;
    } else if (!didInlineIntoChild && childInlinedBytes < smallestChildInlinedBytes) {
      smallestChildInlinedBytes = childInlinedBytes;
    }
  }

  if (!hasChildren) {
    smallestChildInlinedBytes = 0;
  }

  let hints = node.prefetchHints;
  if (didInlineIntoChild) {
    hints |= INLINED_INTO_CHILD;
  }

  let inlinedBytes = didInlineIntoChild ? acceptingChildInlinedBytes : smallestChildInlinedBytes;
  if (
    !headInlineState.inlined &&
    !hasChildren &&
    headGzipSize !== null &&
    inlinedBytes + headGzipSize < config.maxBundleSize
  ) {
    hints |= HEAD_INLINED_INTO_SELF;
    inlinedBytes += headGzipSize;
    headInlineState.inlined = true;
  }

  if (parentGzipSize !== null) {
    if (inlinedBytes + parentGzipSize < config.maxBundleSize) {
      hints |= PARENT_INLINED_INTO_SELF;
      inlinedBytes += parentGzipSize;
    }
  }

  node.prefetchHints = hints;
  return inlinedBytes;
}

function stripMutableFields(node: MutableTreePrefetch): TreePrefetch {
  const slots =
    node.slots === null
      ? null
      : Object.fromEntries(
          Object.entries(node.slots).map(([key, child]) => [key, stripMutableFields(child)]),
        );
  return {
    name: node.name,
    param: node.param,
    prefetchHints: node.prefetchHints,
    slots,
  };
}

function resolvePrefetchInliningConfig(
  config: PrefetchInliningConfig | undefined,
): ResolvedPrefetchInliningConfig {
  if (config) return config;
  return {
    maxBundleSize: DEFAULT_MAX_INLINE_BUNDLE_SIZE,
    maxSize: DEFAULT_SEGMENT_INLINE_THRESHOLD,
  };
}

export async function createRouteTreePrefetch(
  route: AppRouteTreePrefetchRoute,
  options: RouteTreePrefetchResponseOptions = {},
): Promise<TreePrefetch> {
  const precomputedTree = options.measuredSizes ? null : getPrecomputedTree(route);
  const mutableTree = precomputedTree ? null : await buildTree(route, options.measuredSizes);
  if (mutableTree) {
    const headInlineState = { inlined: false };
    computePrefetchHints(
      mutableTree,
      null,
      options.measuredSizes ? options.measuredSizes.head : HEAD_INLINE_SIZE,
      headInlineState,
      resolvePrefetchInliningConfig(options.prefetchInlining),
    );
    if (!headInlineState.inlined) {
      mutableTree.prefetchHints |= HEAD_OUTLINED;
    }
  }
  return precomputedTree ?? stripMutableFields(mutableTree!);
}

export async function createRouteTreePrefetchResponse(
  route: AppRouteTreePrefetchRoute,
  options: RouteTreePrefetchResponseOptions = {},
): Promise<Response> {
  const tree = await createRouteTreePrefetch(route, options);
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": VINEXT_RSC_CONTENT_TYPE,
    [NEXT_DID_POSTPONE_HEADER]: "2",
    Vary: VINEXT_RSC_VARY_HEADER,
  });
  applyRscCompatibilityIdHeader(headers);
  const deploymentId = options.deploymentId ?? getDeploymentId();
  if (deploymentId) headers.set(NEXTJS_DEPLOYMENT_ID_HEADER, deploymentId);

  const payload: {
    buildId?: string;
    staleTime: number;
    tree: TreePrefetch;
  } = { tree, staleTime: -1 };
  if (options.buildId) payload.buildId = options.buildId;

  return new Response(`0:${JSON.stringify(payload)}\n`, { headers });
}
