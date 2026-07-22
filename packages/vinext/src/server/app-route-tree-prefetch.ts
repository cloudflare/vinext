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

const PARENT_INLINED_INTO_SELF = 0b100000;
const INLINED_INTO_CHILD = 0b1000000;
const HEAD_INLINED_INTO_SELF = 0b10000000;

const PAGE_SEGMENT = "__PAGE__";
const SLOT_SEGMENT = "(__SLOT__)";
const SEGMENT_INLINE_SIZE = 1;
const SEGMENT_OUTLINE_SIZE = 4096;
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

export function isRouteTreePrefetchRequest(request: Request): boolean {
  return (
    request.headers.get(RSC_HEADER) === "1" &&
    request.headers.get(NEXT_ROUTER_PREFETCH_HEADER) === "1" &&
    request.headers.get(NEXT_ROUTER_SEGMENT_PREFETCH_HEADER) === "/_tree"
  );
}

function createNode(segment: string, module: unknown): MutableTreePrefetch {
  const { name, param } = routeTreeSegment(segment);
  const measuredSize = estimatePrefetchSize(module);
  const virtualSegmentSize =
    (module === null || module === undefined) && segment !== PAGE_SEGMENT
      ? SEGMENT_INLINE_SIZE
      : null;
  return {
    name,
    param,
    prefetchSize: measuredSize ?? virtualSegmentSize,
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

function explicitPrefetchSize(module: unknown): number | null {
  if (typeof module !== "object" || module === null) return null;
  // Vinext-only escape hatch for tests and applications that want to tune the
  // heuristic route-tree inlining estimate without rendering user components.
  // Next.js measures the prerendered segment payload instead.
  const value = (module as { prefetchSize?: unknown }).prefetchSize;
  if (value === "large") return SEGMENT_OUTLINE_SIZE;
  if (value === "small") return SEGMENT_INLINE_SIZE;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function estimatePrefetchSize(module: unknown): number | null {
  const explicitSize = explicitPrefetchSize(module);
  if (explicitSize !== null) return explicitSize;

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

function modulesByTreePosition(
  modules: readonly unknown[] | null | undefined,
  positions: readonly number[] | null | undefined,
): Map<number, unknown> {
  const byPosition = new Map<number, unknown>();
  for (const [index, position] of (positions ?? []).entries()) {
    byPosition.set(position, modules?.[index]);
  }
  return byPosition;
}

async function buildTree(route: AppRouteTreePrefetchRoute): Promise<MutableTreePrefetch> {
  const layoutsByPosition = layoutModuleByTreePosition(route);
  const root = createNode("", layoutsByPosition.get(0));
  const nodesByPosition = new Map<number, MutableTreePrefetch>([[0, root]]);
  let current = root;

  for (const [index, segment] of route.routeSegments.entries()) {
    const position = index + 1;
    const child = createNode(segment, layoutsByPosition.get(position));
    addChild(current, "children", child);
    nodesByPosition.set(position, child);
    current = child;
  }

  addChild(current, "children", createNode(PAGE_SEGMENT, route.page));

  for (const slot of Object.values(route.slots ?? {})) {
    const ownerPosition =
      slot.layoutIndex === undefined || slot.layoutIndex < 0
        ? route.routeSegments.length
        : (route.layoutTreePositions?.[slot.layoutIndex] ?? route.routeSegments.length);
    const owner = nodesByPosition.get(ownerPosition) ?? current;
    const slotRoot = createNode(SLOT_SEGMENT, slot.layout);
    let slotCurrent = slotRoot;
    const slotConfigLayoutsByPosition = modulesByTreePosition(
      slot.configLayouts,
      slot.configLayoutTreePositions,
    );
    const slotRouteSegments = slot.routeSegments ?? [];
    for (const [index, segment] of slotRouteSegments.entries()) {
      const position = index + 1;
      const child = createNode(segment, slotConfigLayoutsByPosition.get(position));
      addChild(slotCurrent, "children", child);
      slotCurrent = child;
    }
    addChild(slotCurrent, "children", createNode(PAGE_SEGMENT, slot.page ?? slot.default));
    addChild(owner, slot.name, slotRoot);
  }

  return root;
}

function computePrefetchHints(
  node: MutableTreePrefetch,
  parentGzipSize: number | null,
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
    const childInlinedBytes = computePrefetchHints(child, childParentSize, headInlineState, config);

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
  const isBundleTerminal = !didInlineIntoChild;
  if (
    !headInlineState.inlined &&
    isBundleTerminal &&
    node.name === PAGE_SEGMENT &&
    inlinedBytes + HEAD_INLINE_SIZE < config.maxBundleSize
  ) {
    hints |= HEAD_INLINED_INTO_SELF;
    inlinedBytes += HEAD_INLINE_SIZE;
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

export async function createRouteTreePrefetchResponse(
  route: AppRouteTreePrefetchRoute,
  options: RouteTreePrefetchResponseOptions = {},
): Promise<Response> {
  const tree = await buildTree(route);
  computePrefetchHints(
    tree,
    null,
    { inlined: false },
    resolvePrefetchInliningConfig(options.prefetchInlining),
  );
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
  } = { tree: stripMutableFields(tree), staleTime: -1 };
  if (options.buildId) payload.buildId = options.buildId;

  return new Response(`0:${JSON.stringify(payload)}\n`, { headers });
}
