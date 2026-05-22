import { createElement, isValidElement, Suspense } from "react";
import { isUnknownRecord } from "../utils/record.js";
import { stripBasePath } from "../utils/base-path.js";
import { decodeMatchedParams, splitPathnameForRouteMatch } from "../routing/utils.js";
import type { RouteManifest, RouteManifestRoute } from "../routing/app-route-graph.js";
import { stripRscCacheBustingSearchParam, stripRscSuffix } from "./app-rsc-cache-busting.js";
import {
  AppElementsWire,
  APP_PREFETCH_LOADING_SHELL_MARKER_KEY,
  type AppElementValue,
  type AppElements,
} from "./app-elements.js";

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
  pageElementIds: readonly string[];
  routeId: string;
};

type OptimisticNavigationPayload = {
  elements: AppElements;
  params: Record<string, string | string[]>;
  template: OptimisticRouteTemplate;
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
): OptimisticRouteMatch | null {
  if (index === urlParts.length) {
    if (node.route !== null) {
      return { route: node.route, params: Object.create(null) };
    }
    if (node.optionalCatchAllChild !== null) {
      return {
        route: node.optionalCatchAllChild.route,
        params: Object.create(null),
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
    return matchNode(staticChild, urlParts, index + 1);
  }

  if (node.dynamicChild !== null) {
    const match = matchNode(node.dynamicChild.node, urlParts, index + 1);
    if (match === null) return null;
    match.params[node.dynamicChild.paramName] = segment;
    return match;
  }

  if (node.catchAllChild !== null) {
    return {
      route: node.catchAllChild.route,
      params: {
        [node.catchAllChild.paramName]: urlParts.slice(index),
      },
    };
  }

  if (node.optionalCatchAllChild !== null) {
    return {
      route: node.optionalCatchAllChild.route,
      params: {
        [node.optionalCatchAllChild.paramName]: urlParts.slice(index),
      },
    };
  }

  return null;
}

function hrefToRouteParts(href: string, basePath: string): string[] | null {
  let url: URL;
  try {
    url = new URL(href, "https://vinext.local");
  } catch {
    return null;
  }

  stripRscCacheBustingSearchParam(url);
  const withoutRscSuffix = stripRscSuffix(url.pathname);
  const appPathname = stripBasePath(withoutRscSuffix, basePath);
  return splitPathnameForRouteMatch(appPathname === "" ? "/" : appPathname);
}

export function matchOptimisticRouteManifestRoute(options: {
  basePath: string;
  href: string;
  routeManifest: RouteManifest;
}): OptimisticRouteMatch | null {
  const urlParts = hrefToRouteParts(options.href, options.basePath);
  if (urlParts === null) return null;

  const match = matchNode(getRouteTrie(options.routeManifest), urlParts, 0);
  if (match === null) return null;

  decodeMatchedParams(match.params);
  return match;
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

function getPageElementIds(elements: AppElements): string[] {
  return Object.keys(elements)
    .filter((key) => AppElementsWire.parseElementKey(key)?.kind === "page")
    .sort();
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
  if (match === null || !match.route.isDynamic) return null;
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

  const pageElementIds = getPageElementIds(options.elements);
  if (pageElementIds.length === 0) return null;

  return {
    elements: options.elements,
    mountedSlotsHeader: options.mountedSlotsHeader,
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

export function resolveOptimisticNavigationPayload(options: {
  basePath: string;
  href: string;
  interceptionContext: string | null;
  mountedSlotsHeader: string | null;
  routeManifest: RouteManifest;
  templates: ReadonlyMap<string, OptimisticRouteTemplate>;
}): OptimisticNavigationPayload | null {
  if (options.interceptionContext !== null) return null;

  const match = matchOptimisticRouteManifestRoute({
    basePath: options.basePath,
    href: options.href,
    routeManifest: options.routeManifest,
  });
  if (match === null || !match.route.isDynamic) return null;

  const template = options.templates.get(
    getOptimisticRouteTemplateKey({
      interceptionContext: options.interceptionContext,
      mountedSlotsHeader: options.mountedSlotsHeader,
      routeId: match.route.id,
    }),
  );
  if (template === undefined) return null;
  if (template.mountedSlotsHeader !== options.mountedSlotsHeader) return null;

  return {
    elements: createOptimisticRouteElements(template),
    params: match.params,
    template,
  };
}
