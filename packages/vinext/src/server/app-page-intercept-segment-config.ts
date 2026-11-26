import type { FetchCacheMode } from "vinext/shims/fetch-cache";
import {
  collectAppPageStaticGenerationRuntimes,
  collectAppPageStaticParamsWalkSegments,
  hasAppPageGenerateStaticParamsAtLastDynamicSegment,
  isAppPageStaticEligible,
  isEdgeRuntime,
  resolveAppPageDynamicConfig,
  resolveAppPageDynamicParamsConfig,
  resolveAppPageSegmentConfig,
  resolveAppPageStaticGenerationRuntime,
} from "./app-segment-config.js";
import { SIBLING_PAGE_INTERCEPT_SLOT_KEY } from "./app-rsc-route-matching.js";
import { withoutInterceptionMarker } from "../routing/route-pattern.js";
import { compareFolderNames } from "../utils/compare.js";
import {
  resolveAppPageGenerateStaticParamsSources,
  type GenerateStaticParamsSource,
} from "./app-page-request.js";

type SegmentModule = Record<string, unknown>;

type AppPageInterceptSegmentConfigSlot = {
  configLayouts?: readonly (SegmentModule | null | undefined)[] | null;
  configLayoutTreePositions?: readonly number[] | null;
  default?: SegmentModule | null;
  layout?: SegmentModule | null;
  layoutIndex?: number;
  name?: string;
  ownerTreePosition?: number | null;
  page?: SegmentModule | null;
  routeSegments?: readonly string[] | null;
};

/** The parts of the route an interception renders under that its config reads. */
export type AppPageInterceptSegmentConfigRoute = {
  layouts?: readonly (SegmentModule | null | undefined)[];
  layoutTreePositions?: readonly number[];
  routeSegments?: readonly string[];
  slots?: Readonly<Record<string, AppPageInterceptSegmentConfigSlot>> | null;
};

/** The parts of the interception's options its config reads. */
export type AppPageInterceptSegmentConfigOptions = {
  interceptBranchSegments?: readonly string[] | null;
  interceptLayoutSegments?: readonly (readonly string[])[] | null;
  interceptLayouts?: readonly unknown[] | null;
  interceptOwnerDefault?: unknown;
  /**
   * The slot owner's `default`, which the interception's own loader tree puts
   * in children, for its generators and `dynamicParams` alone.
   */
  interceptOwnerDefaultForStaticParams?: unknown;
  interceptPage?: unknown;
  interceptSlotKey: string;
  interceptSourcePageSegments?: readonly string[] | null;
  rendersWholeInterceptingRoute?: boolean;
};

export type AppPageInterceptSegmentConfig = {
  dynamicConfig: string | undefined;
  dynamicParamsConfig: boolean | undefined;
  dynamicStaleTimeSeconds: number | undefined;
  fetchCacheMode: FetchCacheMode | null;
  /** The interception's own `generateStaticParams` chain, which its params must match. */
  generateStaticParams: GenerateStaticParamsSource[];
  /** Whether any segment of the interception exports `generateStaticParams`. */
  hasAnyGenerateStaticParams: boolean;
  /** Whether one sits at or below the interception's last dynamic segment. */
  hasGenerateStaticParams: boolean;
  /** Whether the interception's own segments choose the edge runtime. */
  isEdgeRuntime: boolean;
  /** Whether the interception's route has a dynamic segment. */
  isDynamicRoute: boolean;
  /** The interception's route segments, which its generators' implicit tags name. */
  routeSegments: readonly string[];
  isStaticEligible: boolean;
  isStaticGenerationEdgeRuntime: boolean;
  revalidateSeconds: number | null;
  /** The `dynamic` of the interception's own tree, which its params check reads. */
  staticParamsDynamicConfig: string | undefined;
};

/**
 * Next.js renders an interception as its own route, whose loader tree holds
 * the owner's layouts and the intercepting page, never the source's page, so
 * its segment config comes from those modules alone. A sibling intercept's
 * branch takes the children position below its owner folder; a slot
 * intercept's branch takes its slot, beside the other slots of the owner's
 * layouts, and children renders the owner's default. Rendered whole, for a
 * source that shares none of that tree, the other slots show their defaults
 * too, and the owner's default is one of its segments.
 */
export function resolveAppPageInterceptSegmentConfig(
  route: AppPageInterceptSegmentConfigRoute,
  interceptOpts: AppPageInterceptSegmentConfigOptions,
): AppPageInterceptSegmentConfig {
  const routeLayouts = route.layouts ?? [];
  const routeSegments = route.routeSegments ?? [];
  const isSiblingIntercept = interceptOpts.interceptSlotKey === SIBLING_PAGE_INTERCEPT_SLOT_KEY;
  const interceptedSlot = isSiblingIntercept
    ? undefined
    : route.slots?.[interceptOpts.interceptSlotKey];
  const branchSegments = (interceptOpts.interceptBranchSegments ?? []).map(
    withoutInterceptionMarker,
  );
  const interceptLayouts = (interceptOpts.interceptLayouts ?? []) as readonly (
    | SegmentModule
    | null
    | undefined
  )[];
  const interceptLayoutPositions = (interceptOpts.interceptLayoutSegments ?? []).map(
    (segments) => segments.length,
  );
  // The main-tree position of the folder that owns the interception.
  const ownerPosition = isSiblingIntercept
    ? interceptOpts.interceptSourcePageSegments
      ? interceptOpts.interceptSourcePageSegments.length - branchSegments.length
      : routeSegments.length
    : (interceptedSlot?.ownerTreePosition ??
      route.layoutTreePositions?.[interceptedSlot?.layoutIndex ?? -1] ??
      routeSegments.length);
  const ownerLayoutIndexes = routeLayouts.flatMap((_, index) =>
    (route.layoutTreePositions?.[index] ?? 0) <= ownerPosition ? [index] : [],
  );
  const ownerLayouts = ownerLayoutIndexes.map((index) => routeLayouts[index]);
  const ownerLayoutPositions = ownerLayoutIndexes.map(
    (index) => route.layoutTreePositions?.[index] ?? 0,
  );
  const ownerSegments = routeSegments.slice(0, ownerPosition);
  const page = interceptOpts.interceptPage as SegmentModule | null | undefined;
  const rendersWholeInterceptingRoute =
    !isSiblingIntercept && interceptOpts.rendersWholeInterceptingRoute === true;
  // The other slots of the owner's layouts render beside the interception:
  // a matched one with its own layouts and page, one without a page as a
  // lone `__DEFAULT__` segment, without the slot's layouts.
  const otherSlots = Object.entries(route.slots ?? {}).flatMap(([slotKey, slot]) =>
    slotKey === interceptOpts.interceptSlotKey ||
    (slot.ownerTreePosition ?? route.layoutTreePositions?.[slot.layoutIndex ?? 0] ?? 0) >
      ownerPosition
      ? []
      : [slot],
  );
  const retainedBranches = otherSlots.flatMap((slot) => {
    const slotPage = rendersWholeInterceptingRoute ? null : slot.page;
    return [
      {
        configLayouts: slotPage ? slot.configLayouts : null,
        configLayoutTreePositions: slotPage ? slot.configLayoutTreePositions : null,
        isDefault: !slotPage,
        layout: slotPage ? slot.layout : null,
        name: slot.name,
        ownerTreePosition: slot.ownerTreePosition,
        page: slotPage ?? slot.default,
        routeSegments: slot.routeSegments,
      },
    ];
  });
  // Next.js visits children before the other slots, and the last segment's
  // value wins, while this reducer keeps the first parallel value, so the
  // owner's default goes after the other slots' defaults.
  if (rendersWholeInterceptingRoute) {
    retainedBranches.push({
      configLayouts: null,
      configLayoutTreePositions: null,
      isDefault: true,
      layout: null,
      name: "children",
      ownerTreePosition: ownerPosition,
      page: (interceptOpts.interceptOwnerDefault as SegmentModule | null | undefined) ?? null,
      routeSegments: [],
    });
  }
  const interceptBranch = {
    configLayouts: interceptLayouts,
    configLayoutTreePositions: interceptLayoutPositions,
    layout: interceptedSlot?.layout,
    name: interceptedSlot?.name,
    ownerTreePosition: ownerPosition,
    page,
    routeSegments: branchSegments,
  };
  const siblingTree = {
    layouts: [...ownerLayouts, ...interceptLayouts],
    layoutTreePositions: [
      ...ownerLayoutPositions,
      ...interceptLayoutPositions.map((position) => ownerPosition + position),
    ],
    page,
    routeSegments: [...ownerSegments, ...branchSegments],
  };
  const slotTree = {
    layouts: ownerLayouts,
    layoutTreePositions: ownerLayoutPositions,
    page: null,
    routeSegments: ownerSegments,
  };
  const ownerDefault = (interceptOpts.interceptOwnerDefault ??
    interceptOpts.interceptOwnerDefaultForStaticParams) as SegmentModule | null | undefined;
  // Next.js collects the generators and `dynamicParams` of the interception's
  // loader tree, breadth-first, into one chain, the intercepting page's as a
  // route page's. No other slot matches in that tree, nor does a slot
  // intercept's children, so they take part with their defaults, whatever
  // the source shows in them. A default follows its owner's child segment;
  // a slot intercept's branch starts a level below the slot, so the defaults
  // beside it come before its first segment.
  const defaults = [
    ...(isSiblingIntercept
      ? []
      : [
          {
            module: ownerDefault,
            ownerTreePosition: ownerPosition,
            slot: null,
          },
        ]),
    ...otherSlots.map((slot) => ({
      module: slot.default,
      ownerTreePosition: slot.ownerTreePosition ?? ownerPosition,
      slot: slot.name ?? "",
    })),
  ];
  const slotDepth = isSiblingIntercept ? 0 : 1;
  const chain = [
    ...ownerLayouts.map((module, index) => {
      const position = ownerLayoutPositions[index] ?? 0;
      return { depth: position, isDefault: false, module, position, slot: null };
    }),
    ...(isSiblingIntercept
      ? []
      : [
          {
            depth: ownerPosition + 1,
            isDefault: false,
            module: interceptedSlot?.layout,
            position: ownerPosition,
            slot: interceptedSlot?.name ?? "",
          },
        ]),
    ...defaults.map(({ module, ownerTreePosition, slot }) => ({
      depth: ownerTreePosition + 1,
      isDefault: true,
      module,
      position: ownerTreePosition,
      slot,
    })),
    ...interceptLayouts.map((module, index) => {
      const position = ownerPosition + (interceptLayoutPositions[index] ?? 0);
      return { depth: position + slotDepth, isDefault: false, module, position, slot: null };
    }),
  ].sort(
    // Beside each other, children comes first, then the slots by folder name.
    (a, b) =>
      a.depth - b.depth ||
      (a.slot === null ? (b.slot === null ? 0 : -1) : b.slot === null ? 1 : 0) ||
      compareFolderNames(a.slot ?? "", b.slot ?? ""),
  );
  const layoutChain = chain.filter((entry) => !entry.isDefault);
  const staticParamsTree = {
    fetchCachePerSource: true,
    layouts: chain.map((entry) => entry.module),
    layoutTreePositions: chain.map((entry) => entry.position),
    page,
    routeSegments: siblingTree.routeSegments,
  };
  const dynamicParamsTree = {
    layouts: layoutChain.map((entry) => entry.module),
    layoutTreePositions: layoutChain.map((entry) => entry.position),
    page,
    parallelBranches: defaults.map(({ module, ownerTreePosition }) => ({
      isDefault: true,
      ownerTreePosition:
        ownerTreePosition === ownerPosition ? ownerTreePosition - slotDepth : ownerTreePosition,
      page: module,
    })),
    routeSegments: siblingTree.routeSegments,
  };
  // The intercepting page and its layouts are the route's own segments, so
  // their `dynamic` applies as a page's would, in a slot as well.
  const configLayouts = [
    ...ownerLayouts,
    ...(isSiblingIntercept ? [] : [interceptedSlot?.layout]),
    ...interceptLayouts,
  ];
  const config = resolveAppPageSegmentConfig({
    layouts: configLayouts,
    page,
    parallelBranches: retainedBranches,
    parallelPages: retainedBranches.map((branch) => branch.page),
  });
  // Next.js classifies the interception from that same tree.
  const defaultBranches = otherSlots.map((slot) => ({
    isDefault: true,
    name: slot.name,
    ownerTreePosition: slot.ownerTreePosition,
    page: slot.default,
  }));
  const staticGenerationTree = isSiblingIntercept
    ? { ...siblingTree, parallelBranches: defaultBranches }
    : {
        ...slotTree,
        childrenSlot: { ownerTreePath: ownerSegments.join("/"), state: "default" as const },
        page: ownerDefault,
        parallelBranches: [...defaultBranches, interceptBranch],
      };
  // As for the whole intercepting route above, the owner's default goes
  // after the other slots' defaults.
  const staticParamsBranches = [
    ...defaultBranches,
    ...(isSiblingIntercept
      ? []
      : [
          {
            isDefault: true,
            name: "children",
            ownerTreePosition: ownerPosition,
            page: ownerDefault,
          },
        ]),
  ];
  const staticParamsTreeConfig = {
    layouts: configLayouts,
    page,
    parallelBranches: staticParamsBranches,
  };
  const walkSegments = collectAppPageStaticParamsWalkSegments(staticGenerationTree);
  const hasGenerateStaticParams =
    hasAppPageGenerateStaticParamsAtLastDynamicSegment(staticGenerationTree);
  const isDynamicRoute = walkSegments.some((segment) => segment.dynamic);
  const isStaticGenerationEdgeRuntime = isEdgeRuntime(
    resolveAppPageStaticGenerationRuntime(
      collectAppPageStaticGenerationRuntimes(staticGenerationTree),
    ),
  );
  return {
    dynamicConfig: config.dynamicConfig,
    dynamicParamsConfig: resolveAppPageDynamicParamsConfig(dynamicParamsTree),
    dynamicStaleTimeSeconds: config.dynamicStaleTimeSeconds,
    fetchCacheMode: config.fetchCache ?? null,
    // Next.js generates the interception's paths from its own loader tree, so
    // the target page's generators and `dynamicParams` never apply to it.
    generateStaticParams: resolveAppPageGenerateStaticParamsSources(staticParamsTree),
    hasAnyGenerateStaticParams: walkSegments.some((segment) => segment.generateStaticParams),
    hasGenerateStaticParams,
    isDynamicRoute,
    isEdgeRuntime: isEdgeRuntime(config.runtime),
    isStaticEligible: isAppPageStaticEligible({
      dynamicConfig: config.dynamicConfig,
      hasGenerateStaticParams,
      isDynamicRoute,
      isStaticGenerationEdgeRuntime,
      revalidateSeconds: config.revalidateSeconds,
    }),
    isStaticGenerationEdgeRuntime,
    revalidateSeconds: config.revalidateSeconds,
    staticParamsDynamicConfig: resolveAppPageDynamicConfig(staticParamsTreeConfig),
    // As Next.js's interception page, `club/[slug]/(.)pics/[id]`, names it.
    routeSegments: [...ownerSegments, ...(interceptOpts.interceptBranchSegments ?? [])],
  };
}
