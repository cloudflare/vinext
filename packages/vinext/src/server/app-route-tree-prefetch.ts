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
import { createElement, type ComponentType } from "react";
import { makeThenableParams } from "vinext/shims/thenable-params";
import { getDeploymentId } from "../utils/deployment-id.js";
import { resolveAppPageBranchParams, resolveAppPageSegmentParams } from "./app-page-params.js";

const HAS_RUNTIME_PREFETCH = 0b00001;
const PARENT_INLINED_INTO_SELF = 0b100000;
const INLINED_INTO_CHILD = 0b1000000;
const HEAD_INLINED_INTO_SELF = 0b10000000;
const PREFETCH_DISABLED = 0b10000000000;
const STATIC_PREFETCH_DISABLED = HAS_RUNTIME_PREFETCH | PREFETCH_DISABLED;

const PAGE_SEGMENT = "__PAGE__";
const SLOT_SEGMENT = "(__SLOT__)";
const SEGMENT_INLINE_SIZE = 1;
const SEGMENT_OUTLINE_SIZE = 4096;
const SEGMENT_INLINE_THRESHOLD = 2048;
const HEAD_INLINE_SIZE = 1;
const MAX_INLINE_BUNDLE_SIZE = 10240;
const NEXT_DID_POSTPONE_HEADER = "x-nextjs-postponed";

type AppRouteTreePrefetchParams = Record<string, string | string[]>;

export type RouteTreePrefetchRenderer = (
  model: unknown,
  options?: unknown,
) => Promise<ReadableStream<Uint8Array>>;

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
  staticSiblings?: readonly string[] | null;
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
  searchParams?: URLSearchParams | null;
};

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

async function createNode(
  segment: string,
  module: unknown,
  params: AppRouteTreePrefetchParams,
  searchParams: AppRouteTreePrefetchParams,
  renderToReadableStream: RouteTreePrefetchRenderer,
  staticSiblings?: readonly string[] | null,
): Promise<MutableTreePrefetch> {
  const { name, param } = routeTreeSegment(segment, staticSiblings);
  const measuredSize = await estimatePrefetchSize(
    module,
    params,
    searchParams,
    renderToReadableStream,
  );
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

function routeTreeSegment(
  segment: string,
  staticSiblings?: readonly string[] | null,
): { name: string; param: TreePrefetchParam | null } {
  if (segment.startsWith(":")) {
    const rest = segment.slice(1);
    if (rest.endsWith("+")) {
      return dynamicRouteTreeSegment(rest.slice(0, -1), "c", staticSiblings);
    }
    if (rest.endsWith("*")) {
      return dynamicRouteTreeSegment(rest.slice(0, -1), "oc", staticSiblings);
    }
    return dynamicRouteTreeSegment(rest, "d", staticSiblings);
  }
  if (segment.startsWith("[[...") && segment.endsWith("]]")) {
    return dynamicRouteTreeSegment(segment.slice(5, -2), "oc", staticSiblings);
  }
  if (segment.startsWith("[...") && segment.endsWith("]")) {
    return dynamicRouteTreeSegment(segment.slice(4, -1), "c", staticSiblings);
  }
  if (segment.startsWith("[") && segment.endsWith("]")) {
    return dynamicRouteTreeSegment(segment.slice(1, -1), "d", staticSiblings);
  }
  return { name: segment, param: null };
}

function dynamicRouteTreeSegment(
  name: string,
  type: DynamicParamTypeShort,
  staticSiblings?: readonly string[] | null,
): { name: string; param: TreePrefetchParam } {
  return {
    name,
    param: {
      key: null,
      siblings: staticSiblings?.length ? staticSiblings : null,
      type,
    },
  };
}

function explicitPrefetchSize(module: unknown): number | null {
  if (typeof module !== "object" || module === null) return null;
  const value = (module as { prefetchSize?: unknown }).prefetchSize;
  if (value === "large") return SEGMENT_OUTLINE_SIZE;
  if (value === "small") return SEGMENT_INLINE_SIZE;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

async function gzipStreamByteLength(stream: ReadableStream<Uint8Array>): Promise<number> {
  const ready = (stream as ReadableStream<Uint8Array> & { allReady?: Promise<void> }).allReady;
  if (ready) {
    await ready;
  }

  const gzip = new CompressionStream("gzip") as unknown as ReadableWritablePair<
    Uint8Array,
    Uint8Array
  >;
  const compressed = stream.pipeThrough(gzip);
  return (await new Response(compressed).arrayBuffer()).byteLength;
}

async function estimatePrefetchSize(
  module: unknown,
  params: AppRouteTreePrefetchParams,
  searchParams: AppRouteTreePrefetchParams,
  renderToReadableStream: RouteTreePrefetchRenderer,
): Promise<number | null> {
  const explicitSize = explicitPrefetchSize(module);
  if (explicitSize !== null) return explicitSize;

  if (typeof module !== "object" || module === null) return null;
  const Component = (module as { default?: unknown }).default;
  if (typeof Component !== "function") return null;

  try {
    const props = {
      children: null,
      params: makeThenableParams(params),
      searchParams: makeThenableParams(searchParams),
    };
    return await gzipStreamByteLength(
      await renderToReadableStream(createElement(Component as ComponentType<typeof props>, props)),
    );
  } catch {
    return null;
  }
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

async function buildTree(
  route: AppRouteTreePrefetchRoute,
  params: AppRouteTreePrefetchParams,
  searchParams: AppRouteTreePrefetchParams,
  renderToReadableStream: RouteTreePrefetchRenderer,
): Promise<MutableTreePrefetch> {
  const layoutsByPosition = layoutModuleByTreePosition(route);
  const root = await createNode(
    "",
    layoutsByPosition.get(0),
    resolveAppPageSegmentParams(route.routeSegments, 0, params),
    searchParams,
    renderToReadableStream,
  );
  const nodesByPosition = new Map<number, MutableTreePrefetch>([[0, root]]);
  let current = root;

  for (const [index, segment] of route.routeSegments.entries()) {
    const position = index + 1;
    const child = await createNode(
      segment,
      layoutsByPosition.get(position),
      resolveAppPageSegmentParams(route.routeSegments, position, params),
      searchParams,
      renderToReadableStream,
      route.staticSiblings,
    );
    addChild(current, "children", child);
    nodesByPosition.set(position, child);
    current = child;
  }

  addChild(
    current,
    "children",
    await createNode(PAGE_SEGMENT, route.page, params, searchParams, renderToReadableStream),
  );

  for (const slot of Object.values(route.slots ?? {})) {
    const ownerPosition =
      slot.layoutIndex === undefined || slot.layoutIndex < 0
        ? route.routeSegments.length
        : (route.layoutTreePositions?.[slot.layoutIndex] ?? route.routeSegments.length);
    const owner = nodesByPosition.get(ownerPosition) ?? current;
    const slotOwnerParams = resolveAppPageSegmentParams(route.routeSegments, ownerPosition, params);
    const slotRoot = await createNode(
      SLOT_SEGMENT,
      slot.layout,
      slotOwnerParams,
      searchParams,
      renderToReadableStream,
    );
    let slotCurrent = slotRoot;
    const slotConfigLayoutsByPosition = modulesByTreePosition(
      slot.configLayouts,
      slot.configLayoutTreePositions,
    );
    const slotRouteSegments = slot.routeSegments ?? [];
    for (const [index, segment] of slotRouteSegments.entries()) {
      const position = index + 1;
      const child = await createNode(
        segment,
        slotConfigLayoutsByPosition.get(position),
        {
          ...slotOwnerParams,
          ...resolveAppPageBranchParams(slotRouteSegments, position, params),
        },
        searchParams,
        renderToReadableStream,
      );
      addChild(slotCurrent, "children", child);
      slotCurrent = child;
    }
    addChild(
      slotCurrent,
      "children",
      await createNode(
        PAGE_SEGMENT,
        slot.page ?? slot.default,
        params,
        searchParams,
        renderToReadableStream,
      ),
    );
    addChild(owner, slot.name, slotRoot);
  }

  return root;
}

function computePrefetchHints(
  node: MutableTreePrefetch,
  parentGzipSize: number | null,
  headInlineState: { inlined: boolean },
): number {
  const staticPrefetchDisabled = (node.prefetchHints & STATIC_PREFETCH_DISABLED) !== 0;
  const currentGzipSize = staticPrefetchDisabled ? null : node.prefetchSize;
  const sizeToInline =
    currentGzipSize !== null && currentGzipSize < SEGMENT_INLINE_THRESHOLD ? currentGzipSize : null;

  let didInlineIntoChild = false;
  let acceptingChildInlinedBytes = 0;
  let smallestChildInlinedBytes = Number.POSITIVE_INFINITY;
  let hasChildren = false;

  for (const child of Object.values(node.slots ?? {})) {
    hasChildren = true;
    const childParentSize = didInlineIntoChild
      ? null
      : staticPrefetchDisabled
        ? parentGzipSize
        : sizeToInline;
    const childInlinedBytes = computePrefetchHints(child, childParentSize, headInlineState);

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
  const isBundleTerminal = !didInlineIntoChild && !staticPrefetchDisabled;
  if (
    !headInlineState.inlined &&
    isBundleTerminal &&
    node.name === PAGE_SEGMENT &&
    inlinedBytes + HEAD_INLINE_SIZE < MAX_INLINE_BUNDLE_SIZE
  ) {
    hints |= HEAD_INLINED_INTO_SELF;
    inlinedBytes += HEAD_INLINE_SIZE;
    headInlineState.inlined = true;
  }

  if (parentGzipSize !== null) {
    const canAcceptParent = !staticPrefetchDisabled || didInlineIntoChild;
    if (canAcceptParent && inlinedBytes + parentGzipSize < MAX_INLINE_BUNDLE_SIZE) {
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

function collectSearchParams(
  searchParams: URLSearchParams | null | undefined,
): AppRouteTreePrefetchParams {
  const collected: AppRouteTreePrefetchParams = Object.create(null);
  searchParams?.forEach((value, key) => {
    const current = collected[key];
    if (Array.isArray(current)) {
      collected[key] = [...current, value];
    } else if (current !== undefined) {
      collected[key] = [current, value];
    } else {
      collected[key] = value;
    }
  });
  return collected;
}

export async function createRouteTreePrefetchResponse(
  route: AppRouteTreePrefetchRoute,
  renderToReadableStream: RouteTreePrefetchRenderer,
  params: AppRouteTreePrefetchParams = {},
  options: RouteTreePrefetchResponseOptions = {},
): Promise<Response> {
  const tree = await buildTree(
    route,
    params,
    collectSearchParams(options.searchParams),
    renderToReadableStream,
  );
  computePrefetchHints(tree, null, { inlined: false });
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
