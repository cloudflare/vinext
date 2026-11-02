import type { FetchCacheMode } from "vinext/shims/fetch-cache";
import {
  collectAppPageStaticGenerationRuntimes,
  collectAppPageStaticParamsWalkSegments,
  hasAppPageGenerateStaticParamsAtLastDynamicSegment,
  isAppPageStaticEligible,
  isEdgeRuntime,
  resolveAppPageSegmentConfig,
  resolveAppPageStaticGenerationRuntime,
} from "./app-segment-config.js";
import { SIBLING_PAGE_INTERCEPT_SLOT_KEY } from "./app-rsc-route-matching.js";

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
  interceptPage?: unknown;
  interceptSlotKey: string;
  interceptSourcePageSegments?: readonly string[] | null;
};

export type AppPageInterceptSegmentConfig = {
  dynamicConfig: string | undefined;
  fetchCacheMode: FetchCacheMode | null;
  isStaticEligible: boolean;
  revalidateSeconds: number | null;
};

/**
 * Next.js renders an interception as its own route, whose loader tree holds
 * the owner's layouts and the intercepting page, never the source's page, so
 * its segment config comes from those modules alone. A sibling intercept's
 * branch takes the children position below its owner folder; a slot
 * intercept's branch takes its slot, beside the other slots of the owner's
 * layouts, and children renders the owner's default.
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
  const branchSegments = interceptOpts.interceptBranchSegments ?? [];
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
  // The other slots of the owner's layouts render beside the interception:
  // a matched one with its own layouts and page, one without a page as a
  // lone `__DEFAULT__` segment, without the slot's layouts.
  const retainedBranches = Object.entries(route.slots ?? {}).flatMap(([slotKey, slot]) =>
    slotKey !== interceptOpts.interceptSlotKey &&
    (slot.ownerTreePosition ?? route.layoutTreePositions?.[slot.layoutIndex ?? 0] ?? 0) <=
      ownerPosition
      ? [
          {
            configLayouts: slot.page ? slot.configLayouts : null,
            configLayoutTreePositions: slot.page ? slot.configLayoutTreePositions : null,
            isDefault: !slot.page,
            layout: slot.page ? slot.layout : null,
            name: slot.name,
            ownerTreePosition: slot.ownerTreePosition,
            page: slot.page ?? slot.default,
            routeSegments: slot.routeSegments,
          },
        ]
      : [],
  );
  const tree = isSiblingIntercept
    ? {
        layouts: [...ownerLayouts, ...interceptLayouts],
        layoutTreePositions: [
          ...ownerLayoutPositions,
          ...interceptLayoutPositions.map((position) => ownerPosition + position),
        ],
        page,
        parallelBranches: retainedBranches,
        routeSegments: [...ownerSegments, ...branchSegments],
      }
    : {
        layouts: ownerLayouts,
        layoutTreePositions: ownerLayoutPositions,
        page: null,
        parallelBranches: [
          ...retainedBranches,
          {
            configLayouts: interceptLayouts,
            configLayoutTreePositions: interceptLayoutPositions,
            layout: interceptedSlot?.layout,
            name: interceptedSlot?.name,
            ownerTreePosition: ownerPosition,
            page,
            routeSegments: branchSegments,
          },
        ],
        routeSegments: ownerSegments,
      };
  // The intercepting page and its layouts are the route's own segments, so
  // their `dynamic` applies as a page's would, in a slot as well.
  const config = resolveAppPageSegmentConfig({
    layouts: [
      ...ownerLayouts,
      ...(isSiblingIntercept ? [] : [interceptedSlot?.layout]),
      ...interceptLayouts,
    ],
    page,
    parallelBranches: retainedBranches,
  });
  return {
    dynamicConfig: config.dynamicConfig,
    fetchCacheMode: config.fetchCache ?? null,
    isStaticEligible: isAppPageStaticEligible({
      dynamicConfig: config.dynamicConfig,
      hasGenerateStaticParams: hasAppPageGenerateStaticParamsAtLastDynamicSegment(tree),
      isDynamicRoute: collectAppPageStaticParamsWalkSegments(tree).some(
        (segment) => segment.dynamic,
      ),
      isStaticGenerationEdgeRuntime: isEdgeRuntime(
        resolveAppPageStaticGenerationRuntime(collectAppPageStaticGenerationRuntimes(tree)),
      ),
      revalidateSeconds: config.revalidateSeconds,
    }),
    revalidateSeconds: config.revalidateSeconds,
  };
}
