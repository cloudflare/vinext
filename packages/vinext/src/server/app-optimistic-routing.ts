import { createElement, isValidElement, Suspense } from "react";
import { isUnknownRecord } from "../utils/record.js";
import { stripBasePath } from "../utils/base-path.js";
import { buildParams, decodeMatchedParams, splitPathnameForRouteMatch } from "../routing/utils.js";
import type { RouteManifest, RouteManifestRoute } from "../routing/app-route-graph.js";
import { extractRawRoutePatternParams, matchRoutePattern } from "../routing/route-pattern.js";
import {
  createNestedBfcacheSlotSegmentId,
  deriveBfcacheSegmentIdentity,
  isNestedBfcacheSlotSegmentId,
} from "./bfcache-identity.js";
import { stripRscCacheBustingSearchParam, stripRscSuffix } from "./app-rsc-cache-busting.js";
import {
  AppElementsWire,
  APP_PREFETCH_LOADING_SHELL_MARKER_KEY,
  type AppElementValue,
  type AppElements,
} from "./app-elements.js";
import {
  canonicalizeAppPageParams,
  resolveAppPagePatternStateKey,
  resolveAppPageSemanticSegmentStateKey,
} from "./app-page-segment-state.js";

type OptimisticRouteTrieNode = {
  catchAllChild: { paramName: string; route: RouteManifestRoute } | null;
  dynamicChild: { node: OptimisticRouteTrieNode; paramName: string } | null;
  optionalCatchAllChild: { paramName: string; route: RouteManifestRoute } | null;
  route: RouteManifestRoute | null;
  staticChildren: Map<string, OptimisticRouteTrieNode>;
};

type OptimisticRouteMatch = {
  params: Record<string, string | string[]>;
  route: RouteManifestRoute;
};

export type OptimisticRouteTemplate = {
  elements: AppElements;
  mountedSlotsHeader: string | null;
  omittedBfcacheSegmentIds: readonly string[];
  omittedLayoutIds: readonly string[];
  pageElementIds: readonly string[];
  routeId: string;
};

type OptimisticNavigationPayload = {
  elements: AppElements;
  params: Record<string, string | string[]>;
  routeParams: Record<string, string | string[]>;
  template: OptimisticRouteTemplate;
  urlParts: readonly string[];
};

const routeTrieCache = new WeakMap<RouteManifest, OptimisticRouteTrieNode>();
// Shared never-settling thenable used to suspend optimistic page segments until
// the real RSC payload replaces them.
const OPTIMISTIC_ROUTE_SEGMENT_SUSPENSE_TRIGGER = new Promise<never>(() => {});

export function getOptimisticRouteTemplateKey(options: {
  interceptionContext: string | null;
  mountedSlotsHeader: string | null;
  routeId: string;
}): string {
  return `${options.routeId}\0${options.interceptionContext ?? ""}\0${options.mountedSlotsHeader ?? ""}`;
}

export function getOptimisticPrefetchSourceKey(options: {
  cacheKey: string;
  interceptionContext: string | null;
  mountedSlotsHeader: string | null;
}): string {
  return `${options.cacheKey}\0${options.interceptionContext ?? ""}\0${options.mountedSlotsHeader ?? ""}`;
}

function createNode(): OptimisticRouteTrieNode {
  return {
    catchAllChild: null,
    dynamicChild: null,
    optionalCatchAllChild: null,
    route: null,
    staticChildren: new Map(),
  };
}

function buildRouteTrie(routeManifest: RouteManifest): OptimisticRouteTrieNode {
  const root = createNode();

  for (const route of routeManifest.segmentGraph.routes.values()) {
    let node = root;
    const parts = route.patternParts;

    if (parts.length === 0) {
      node.route ??= route;
      continue;
    }

    for (const [index, part] of parts.entries()) {
      const isTerminal = index === parts.length - 1;
      if (part.startsWith(":") && part.endsWith("+")) {
        if (isTerminal && node.catchAllChild === null) {
          node.catchAllChild = { paramName: part.slice(1, -1), route };
        }
        break;
      }

      if (part.startsWith(":") && part.endsWith("*")) {
        if (isTerminal && node.optionalCatchAllChild === null) {
          node.optionalCatchAllChild = { paramName: part.slice(1, -1), route };
        }
        break;
      }

      if (part.startsWith(":")) {
        const paramName = part.slice(1);
        if (node.dynamicChild === null) {
          node.dynamicChild = { node: createNode(), paramName };
        } else if (node.dynamicChild.paramName !== paramName && import.meta.env.DEV) {
          console.warn(
            `[vinext] Optimistic route trie found conflicting dynamic segments at the same level: :${node.dynamicChild.paramName} vs ${part}`,
          );
        }
        node = node.dynamicChild.node;
        if (isTerminal) node.route ??= route;
        continue;
      }

      let staticChild = node.staticChildren.get(part);
      if (staticChild === undefined) {
        staticChild = createNode();
        node.staticChildren.set(part, staticChild);
      }
      node = staticChild;
      if (isTerminal) node.route ??= route;
    }
  }

  return root;
}

function getRouteTrie(routeManifest: RouteManifest): OptimisticRouteTrieNode {
  const existing = routeTrieCache.get(routeManifest);
  if (existing) return existing;

  const trie = buildRouteTrie(routeManifest);
  routeTrieCache.set(routeManifest, trie);
  return trie;
}

function matchNode(
  node: OptimisticRouteTrieNode,
  urlParts: readonly string[],
  index: number,
  entries: Array<[string, string | string[]]>,
): OptimisticRouteMatch | null {
  if (index === urlParts.length) {
    if (node.route !== null) {
      return { route: node.route, params: buildParams(entries) };
    }
    if (node.optionalCatchAllChild !== null) {
      return {
        route: node.optionalCatchAllChild.route,
        params: buildParams(entries),
      };
    }
    return null;
  }

  const segment = urlParts[index];
  const staticChild = node.staticChildren.get(segment);
  if (staticChild !== undefined) {
    // Static children are authoritative for optimistic routing. If a known
    // static subtree does not contain the remaining URL, do not fall through to
    // a catch-all sibling and render the wrong loading boundary.
    return matchNode(staticChild, urlParts, index + 1, entries);
  }

  if (node.dynamicChild !== null) {
    entries.push([node.dynamicChild.paramName, segment]);
    const match = matchNode(node.dynamicChild.node, urlParts, index + 1, entries);
    if (match !== null) return match;
    entries.pop();
  }

  if (node.catchAllChild !== null) {
    const params = buildParams(entries);
    params[node.catchAllChild.paramName] = urlParts.slice(index);
    return { route: node.catchAllChild.route, params };
  }

  // At this point index < urlParts.length, so remaining always has ≥1 segment.
  if (node.optionalCatchAllChild !== null) {
    const params = buildParams(entries);
    params[node.optionalCatchAllChild.paramName] = urlParts.slice(index);
    return { route: node.optionalCatchAllChild.route, params };
  }

  return null;
}

function hrefToRouteParts(
  href: string,
  basePath: string,
): { normalized: string[]; raw: string[] } | null {
  let url: URL;
  try {
    url = new URL(href, "https://vinext.local");
  } catch {
    return null;
  }

  stripRscCacheBustingSearchParam(url);
  const withoutRscSuffix = stripRscSuffix(url.pathname);
  const appPathname = stripBasePath(withoutRscSuffix, basePath);
  const pathname = appPathname === "" ? "/" : appPathname;
  return {
    normalized: splitPathnameForRouteMatch(pathname),
    raw: pathname.split("/").filter(Boolean),
  };
}

export function matchOptimisticRouteManifestRoute(options: {
  basePath: string;
  href: string;
  routeManifest: RouteManifest;
}): OptimisticRouteMatch | null {
  const urlParts = hrefToRouteParts(options.href, options.basePath);
  if (urlParts === null) return null;

  const match = matchNode(getRouteTrie(options.routeManifest), urlParts.normalized, 0, []);
  if (match === null) return null;

  decodeMatchedParams(match.params);
  return match;
}

function mergeParams(
  target: Record<string, string | string[]>,
  source: Record<string, string | string[]>,
): void {
  for (const [key, value] of Object.entries(source)) {
    target[key] = value;
  }
}

function resolveOptimisticNavigationParams(options: {
  match: OptimisticRouteMatch;
  rawUrlParts: readonly string[];
  routeManifest: RouteManifest;
  urlParts: readonly string[];
}): {
  navigationParams: Record<string, string | string[]>;
  routeParams: Record<string, string | string[]>;
} {
  const routeParams = extractRawRoutePatternParams(
    options.match.route.patternParts,
    options.rawUrlParts,
  );
  canonicalizeAppPageParams(routeParams);
  const navigationParams: Record<string, string | string[]> = { ...routeParams };
  const routeParamNames = new Set(options.match.route.paramNames);

  for (const binding of options.routeManifest.segmentGraph.slotBindings.values()) {
    if (binding.routeId !== options.match.route.id || binding.state !== "active") {
      continue;
    }

    const patternParts = binding.slotPatternParts;
    if (!patternParts) {
      continue;
    }
    if (binding.slotParamNames?.every((name) => routeParamNames.has(name))) {
      continue;
    }

    const matched = matchRoutePattern(options.urlParts, patternParts);
    if (matched) {
      mergeParams(navigationParams, matched);
    }
  }

  return { navigationParams, routeParams };
}

export function resolveOptimisticNavigationParamsForHref(options: {
  basePath: string;
  href: string;
  routeManifest: RouteManifest;
}): Record<string, string | string[]> | null {
  const urlParts = hrefToRouteParts(options.href, options.basePath);
  if (urlParts === null) return null;

  const match = matchOptimisticRouteManifestRoute(options);
  if (match === null) return null;

  return resolveOptimisticNavigationParams({
    match,
    rawUrlParts: urlParts.raw,
    routeManifest: options.routeManifest,
    urlParts: urlParts.normalized,
  }).navigationParams;
}

function collectRenderedBfcacheSegmentIds(
  value: unknown,
  candidates: ReadonlySet<string>,
  rendered: Set<string>,
  depth = 0,
): void {
  if (depth > 100) return;
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectRenderedBfcacheSegmentIds(entry, candidates, rendered, depth + 1);
    }
    return;
  }
  if (!isValidElement(value)) return;

  const props = Reflect.get(value, "props");
  if (!isUnknownRecord(props)) return;
  const id = Reflect.get(props, "id");
  if (typeof id === "string" && candidates.has(id)) {
    rendered.add(id);
  }
  for (const prop of Object.values(props)) {
    collectRenderedBfcacheSegmentIds(prop, candidates, rendered, depth + 1);
  }
}

function getOmittedBfcacheSegmentIds(elements: AppElements): string[] {
  const identities = AppElementsWire.readMetadata(elements).bfcacheSegmentIdentities;
  const candidates = new Set(
    Object.keys(identities).filter(
      (id) => isNestedBfcacheSlotSegmentId(id) && Object.hasOwn(elements, id),
    ),
  );
  if (candidates.size === 0) return [];

  const rendered = new Set<string>();
  for (const value of Object.values(elements)) {
    collectRenderedBfcacheSegmentIds(value, candidates, rendered);
  }
  return [...candidates].filter((id) => !rendered.has(id));
}

function resolveTargetBfcacheSegmentIdentity(options: {
  routeId: string;
  routeManifest: RouteManifest;
  segmentId: string;
  targetRouteParams: Readonly<Record<string, string | string[]>>;
  targetUrlParts: readonly string[];
}): string | undefined {
  const route = options.routeManifest.segmentGraph.routes.get(options.routeId);
  if (!route) return undefined;
  const routeParamNames = new Set(route.paramNames);

  for (const binding of options.routeManifest.segmentGraph.slotBindings.values()) {
    if (binding.routeId !== options.routeId) continue;

    const needsSlotParamOverride =
      binding.state === "active" &&
      binding.slotPatternParts !== undefined &&
      binding.slotPatternParts.length > 0 &&
      !binding.slotParamNames?.every((name) => routeParamNames.has(name));
    const segmentParams = needsSlotParamOverride
      ? (matchRoutePattern(options.targetUrlParts, binding.slotPatternParts!) ??
        options.targetRouteParams)
      : options.targetRouteParams;

    const ownerLayout = binding.ownerLayoutId
      ? options.routeManifest.segmentGraph.layouts.get(binding.ownerLayoutId)
      : undefined;
    const ownerStateKey = ownerLayout
      ? resolveAppPagePatternStateKey(ownerLayout.patternParts, options.targetRouteParams)
      : "";
    const boundSegmentKeys: string[] = [];
    let level = 0;
    for (const segment of binding.routeSegments ?? []) {
      if (segment.startsWith("@")) continue;
      level += 1;
      boundSegmentKeys.push(
        resolveAppPageSemanticSegmentStateKey(
          { marker: null, paramSource: "slot", segment },
          segmentParams,
        ),
      );
      if (createNestedBfcacheSlotSegmentId(binding.slotId, level) !== options.segmentId) continue;

      const identityKey = JSON.stringify(boundSegmentKeys);
      return deriveBfcacheSegmentIdentity({
        activeRouteGraphId: null,
        boundSegmentKey: ownerStateKey ? JSON.stringify([ownerStateKey, identityKey]) : identityKey,
        interceptionTargetRouteGraphId: null,
        kind: "slot",
        ownerLayoutGraphId: binding.ownerLayoutId,
        slotGraphId: binding.slotId,
        state: binding.state,
      });
    }

    if (level === 0 && createNestedBfcacheSlotSegmentId(binding.slotId, 1) === options.segmentId) {
      return deriveBfcacheSegmentIdentity({
        activeRouteGraphId: null,
        boundSegmentKey: ownerStateKey ? JSON.stringify([ownerStateKey, ""]) : "",
        interceptionTargetRouteGraphId: null,
        kind: "slot",
        ownerLayoutGraphId: binding.ownerLayoutId,
        slotGraphId: binding.slotId,
        state: binding.state,
      });
    }
  }
  return undefined;
}

function elementHasSuspenseFallback(value: unknown, depth = 0): boolean {
  if (depth > 100) return false;
  if (Array.isArray(value)) {
    return value.some((entry) => elementHasSuspenseFallback(entry, depth + 1));
  }
  if (!isValidElement(value)) return false;

  const props = Reflect.get(value, "props");
  if (value.type === Suspense && isUnknownRecord(props)) {
    const fallback = Reflect.get(props, "fallback");
    if (fallback !== null && fallback !== undefined) return true;
  }

  if (!isUnknownRecord(props)) return false;
  return elementHasSuspenseFallback(Reflect.get(props, "children"), depth + 1);
}

function getPageElementIds(
  elements: AppElements,
  route: Pick<RouteManifestRoute, "pageId" | "slotIds">,
): string[] {
  const pageElementIds = new Set<string>();
  if (route.pageId && Object.hasOwn(elements, route.pageId)) {
    pageElementIds.add(route.pageId);
  }
  for (const slotId of route.slotIds) {
    const parsed = AppElementsWire.parseElementKey(slotId);
    if (parsed?.kind === "slot" && parsed.name === "children" && Object.hasOwn(elements, slotId)) {
      pageElementIds.add(slotId);
    }
  }
  for (const key of Object.keys(elements)) {
    if (AppElementsWire.parseElementKey(key)?.kind === "page") {
      pageElementIds.add(key);
    }
  }
  return Array.from(pageElementIds).sort();
}

function OptimisticRouteSegment(): null {
  throw OPTIMISTIC_ROUTE_SEGMENT_SUSPENSE_TRIGGER;
}

export function createOptimisticRouteTemplate(options: {
  allowLoadingShell?: boolean;
  basePath: string;
  elements: AppElements;
  href: string;
  interceptionContext: string | null;
  mountedSlotsHeader: string | null;
  routeManifest: RouteManifest;
}): OptimisticRouteTemplate | null {
  const match = matchOptimisticRouteManifestRoute({
    basePath: options.basePath,
    href: options.href,
    routeManifest: options.routeManifest,
  });
  if (match === null || (!options.allowLoadingShell && !match.route.isDynamic)) return null;
  if (options.interceptionContext !== null) return null;

  const metadata = AppElementsWire.readMetadata(options.elements);
  if (metadata.interception !== null || metadata.interceptionContext !== null) return null;

  const routeElement = options.elements[metadata.routeId];
  // Full-prefetch learning is intentionally heuristic: legacy full prefetches
  // are accepted only when the serialized route subtree still contains a
  // Suspense fallback. Authoritative loading-shell prefetches use the marker
  // check below instead.
  if (!options.allowLoadingShell && !elementHasSuspenseFallback(routeElement)) return null;
  if (
    options.allowLoadingShell &&
    options.elements[APP_PREFETCH_LOADING_SHELL_MARKER_KEY] !== "LoadingBoundary"
  ) {
    return null;
  }
  // Shell prefetches must include the eagerly-rendered loading component. A
  // null route element means the server had no route loading boundary.
  if (options.allowLoadingShell && (routeElement === undefined || routeElement === null))
    return null;

  const pageElementIds = getPageElementIds(options.elements, match.route);
  if (pageElementIds.length === 0) return null;

  return {
    elements: options.elements,
    mountedSlotsHeader: options.mountedSlotsHeader,
    omittedBfcacheSegmentIds:
      options.elements[APP_PREFETCH_LOADING_SHELL_MARKER_KEY] === "LoadingBoundary"
        ? getOmittedBfcacheSegmentIds(options.elements)
        : [],
    omittedLayoutIds:
      options.elements[APP_PREFETCH_LOADING_SHELL_MARKER_KEY] === "LoadingBoundary"
        ? metadata.layoutIds.filter((layoutId) => !Object.hasOwn(options.elements, layoutId))
        : [],
    pageElementIds,
    routeId: match.route.id,
  };
}

export function createOptimisticRouteElements(template: OptimisticRouteTemplate): AppElements {
  const elements: Record<string, AppElementValue> = { ...template.elements };
  for (const pageElementId of template.pageElementIds) {
    elements[pageElementId] = createElement(OptimisticRouteSegment);
  }
  return elements;
}

/**
 * A loading-shell prefetch stops at the first loading boundary, so layouts
 * below that boundary are present in the route metadata but absent from the
 * rendered shell. Do not commit that ancestor fallback when one of those
 * omitted layouts is already mounted with the same semantic identity. Next.js
 * keeps the shared segment active in this case, which also means the ancestor
 * loading boundary does not re-trigger.
 */
export function canCommitOptimisticRouteTemplate(options: {
  currentElements: AppElements;
  currentLayoutIds: readonly string[];
  currentParams: Readonly<Record<string, string | string[]>>;
  routeManifest: RouteManifest;
  targetRouteParams: Readonly<Record<string, string | string[]>>;
  targetUrlParts: readonly string[];
  template: OptimisticRouteTemplate;
}): boolean {
  if (
    options.template.omittedLayoutIds.length === 0 &&
    options.template.omittedBfcacheSegmentIds.length === 0
  ) {
    return true;
  }

  const currentLayoutIds = new Set(options.currentLayoutIds);
  const currentIdentities = AppElementsWire.readMetadata(
    options.currentElements,
  ).bfcacheSegmentIdentities;

  for (const layoutId of options.template.omittedLayoutIds) {
    if (!currentLayoutIds.has(layoutId)) continue;
    if (!Object.hasOwn(options.currentElements, layoutId)) continue;

    const layout = options.routeManifest.segmentGraph.layouts.get(layoutId);
    if (layout === undefined) continue;
    const currentIdentity = currentIdentities[layoutId];
    if (currentIdentity !== undefined) {
      const targetIdentity = deriveBfcacheSegmentIdentity({
        boundSegmentKey: resolveAppPagePatternStateKey(
          layout.patternParts,
          options.targetRouteParams,
        ),
        graphId: layout.id,
        kind: "layout",
        rootBoundaryId: layout.rootBoundaryId,
      });
      if (currentIdentity === targetIdentity) return false;
      continue;
    }
    if (
      resolveAppPagePatternStateKey(layout.patternParts, options.currentParams) ===
      resolveAppPagePatternStateKey(layout.patternParts, options.targetRouteParams)
    ) {
      return false;
    }
  }

  for (const segmentId of options.template.omittedBfcacheSegmentIds) {
    if (!Object.hasOwn(options.currentElements, segmentId)) continue;
    const currentIdentity = currentIdentities[segmentId];
    const targetIdentity = resolveTargetBfcacheSegmentIdentity({
      routeId: options.template.routeId,
      routeManifest: options.routeManifest,
      segmentId,
      targetRouteParams: options.targetRouteParams,
      targetUrlParts: options.targetUrlParts,
    });
    if (
      currentIdentity !== undefined &&
      targetIdentity !== undefined &&
      currentIdentity === targetIdentity
    ) {
      return false;
    }
  }

  return true;
}

export function resolveOptimisticNavigationPayload(options: {
  basePath: string;
  href: string;
  interceptionContext: string | null;
  mountedSlotsHeader: string | null;
  routeManifest: RouteManifest;
  templates: ReadonlyMap<string, OptimisticRouteTemplate>;
}): OptimisticNavigationPayload | null {
  if (options.interceptionContext !== null) return null;

  const urlParts = hrefToRouteParts(options.href, options.basePath);
  if (urlParts === null) return null;

  const match = matchOptimisticRouteManifestRoute({
    basePath: options.basePath,
    href: options.href,
    routeManifest: options.routeManifest,
  });
  if (match === null) return null;

  const template = options.templates.get(
    getOptimisticRouteTemplateKey({
      interceptionContext: options.interceptionContext,
      mountedSlotsHeader: options.mountedSlotsHeader,
      routeId: match.route.id,
    }),
  );
  if (template === undefined) return null;
  if (template.mountedSlotsHeader !== options.mountedSlotsHeader) return null;

  const { navigationParams, routeParams } = resolveOptimisticNavigationParams({
    match,
    rawUrlParts: urlParts.raw,
    routeManifest: options.routeManifest,
    urlParts: urlParts.normalized,
  });
  return {
    elements: createOptimisticRouteElements(template),
    params: navigationParams,
    routeParams,
    template,
    urlParts: urlParts.normalized,
  };
}
