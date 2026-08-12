import {
  cloneElement,
  createElement,
  isValidElement,
  Suspense,
  use,
  type ReactElement,
  type ReactNode,
} from "react";
import { isUnknownRecord } from "../utils/record.js";
import { stripBasePath } from "../utils/base-path.js";
import { buildParams, decodeMatchedParams, splitPathnameForRouteMatch } from "../routing/utils.js";
import type { RouteManifest, RouteManifestRoute } from "../routing/app-route-graph.js";
import { matchRoutePattern } from "../routing/route-pattern.js";
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
  preservePageElements: boolean;
  routeId: string;
  suspendNestedBoundaries: boolean;
};

type OptimisticNavigationPayload = {
  elements: AppElements;
  params: Record<string, string | string[]>;
  template: OptimisticRouteTemplate;
};

const routeTrieCache = new WeakMap<RouteManifest, OptimisticRouteTrieNode>();
const optimisticSuspenseBoundaryKeys = new WeakMap<object, string>();
const optimisticThenableViewFinalizers = new WeakMap<object, (value: unknown) => void>();
let optimisticSuspenseBoundaryKeyCounter = 0;
// Shared never-settling thenable used to suspend optimistic page segments until
// the real RSC payload replaces them.
const OPTIMISTIC_ROUTE_SEGMENT_SUSPENSE_TRIGGER = new Promise<never>(() => {});
const REACT_LAZY_TYPE = Symbol.for("react.lazy");

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

  const match = matchNode(getRouteTrie(options.routeManifest), urlParts, 0, []);
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
  routeManifest: RouteManifest;
  urlParts: readonly string[];
}): Record<string, string | string[]> {
  const navigationParams: Record<string, string | string[]> = { ...options.match.params };

  for (const binding of options.routeManifest.segmentGraph.slotBindings.values()) {
    // Unlike the server-side resolveSlotParamOverrides, this loop doesn't skip
    // slots whose slotParamNames are all already route params. That's a no-op
    // merge in practice (identical values) but keeps client-side logic simpler.
    if (binding.routeId !== options.match.route.id || binding.state !== "active") {
      continue;
    }

    const patternParts = binding.slotPatternParts;
    if (!patternParts) {
      continue;
    }

    // Slot params are decoded once (from urlParts via splitPathnameForRouteMatch),
    // matching the server-side resolveSlotParamOverrides decode pass. Route params
    // are decoded a second time via decodeMatchedParams(match.params) above — a
    // pre-existing asymmetry that has no practical effect for normal segments but
    // means an encoded catch-all (%25/%2F) could differ between route and slot
    // params in the same payload. TODO: converge the decode passes.
    const matched = matchRoutePattern(options.urlParts, patternParts);
    if (matched) {
      mergeParams(navigationParams, matched);
    }
  }

  return navigationParams;
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

type OptimisticLazyNodeValue = {
  init: (payload: unknown) => unknown;
  payload: unknown;
};

function readOptimisticLazyNode(value: unknown): OptimisticLazyNodeValue | null {
  if (
    (typeof value !== "object" && typeof value !== "function") ||
    value === null ||
    Reflect.get(value, "$$typeof") !== REACT_LAZY_TYPE
  ) {
    return null;
  }
  const init = Reflect.get(value, "_init");
  if (typeof init !== "function") return null;
  return { init, payload: Reflect.get(value, "_payload") };
}

function isOptimisticThenable(value: unknown): value is Promise<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof Reflect.get(value, "then") === "function"
  );
}

function readFulfilledOptimisticThenable(value: Promise<unknown>): unknown {
  return Reflect.get(value, "status") === "fulfilled"
    ? Reflect.get(value, "value")
    : OPTIMISTIC_ROUTE_SEGMENT_SUSPENSE_TRIGGER;
}

function OptimisticResolvedThenable({ value }: { value: Promise<unknown> }): ReactNode {
  return suspendNestedSuspenseBoundaries(use(value)) as ReactNode;
}

function OptimisticResolvedLazyNode({ value }: { value: OptimisticLazyNodeValue }): ReactNode {
  return suspendNestedSuspenseBoundaries(value.init(value.payload)) as ReactNode;
}

function getOptimisticSuspenseBoundaryKey(value: object): string {
  let key = optimisticSuspenseBoundaryKeys.get(value);
  if (key === undefined) {
    optimisticSuspenseBoundaryKeyCounter += 1;
    key = `__vinext_optimistic_suspense_${optimisticSuspenseBoundaryKeyCounter}`;
    optimisticSuspenseBoundaryKeys.set(value, key);
  }
  return key;
}

type OptimisticReactNodeTraversal = {
  transformed: WeakMap<object, unknown>;
};

function readOptimisticIterable(value: unknown): Iterable<unknown> | null {
  if (
    (typeof value !== "object" && typeof value !== "function") ||
    value === null ||
    Array.isArray(value) ||
    value instanceof Map
  ) {
    return null;
  }
  let owner: object | null = value as object;
  while (owner !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, Symbol.iterator);
    if (descriptor !== undefined) {
      return (
        "value" in descriptor
          ? typeof descriptor.value === "function"
          : typeof descriptor.get === "function"
      )
        ? (value as Iterable<unknown>)
        : null;
    }
    owner = Object.getPrototypeOf(owner) as object | null;
  }
  return null;
}

function readLazilyTransformableOptimisticIterable(value: unknown): Iterable<unknown> | null {
  const iterable = readOptimisticIterable(value);
  if (iterable === null || value instanceof Set) return null;

  // Class instances are commonly opaque Flight data. Plain iterable objects
  // are the shape React uses for custom ReactNode collections, but only wrap
  // reusable collections. Iterator objects expose next() themselves; leave
  // those one-shot values untouched without invoking their iterator factory.
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  let owner: object | null = value as object;
  while (owner !== null) {
    if (Object.getOwnPropertyDescriptor(owner, "next") !== undefined) return null;
    owner = Object.getPrototypeOf(owner) as object | null;
  }
  return iterable;
}

function readPlainOptimisticRecord(value: unknown): Record<string, unknown> | null {
  if (!isUnknownRecord(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value : null;
}

function getOptimisticRecordDataEntries(
  value: Record<string, unknown>,
): Array<[string, PropertyDescriptor & { value: unknown }]> {
  const entries: Array<[string, PropertyDescriptor & { value: unknown }]> = [];
  for (const property of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, property);
    if (descriptor?.enumerable === true && "value" in descriptor) {
      entries.push([property, descriptor as PropertyDescriptor & { value: unknown }]);
    }
  }
  return entries;
}

function isOptimisticReactNodeProp(value: unknown, seen = new WeakSet<object>()): boolean {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const entry = pending.pop();
    if ((typeof entry !== "object" && typeof entry !== "function") || entry === null) continue;

    const objectEntry = entry as object;
    if (seen.has(objectEntry)) continue;
    seen.add(objectEntry);

    if (isValidElement(entry) || readOptimisticLazyNode(entry) !== null) return true;
    if (isOptimisticThenable(entry)) {
      const status = Reflect.get(entry, "status");
      if (status === "rejected") continue;
      if (status !== "fulfilled") return true;
      pending.push(Reflect.get(entry, "value"));
      continue;
    }
    if (Array.isArray(entry)) {
      for (let index = 0; index < entry.length; index += 1) {
        const descriptor = findOptimisticPropertyDescriptor(entry, `${index}`);
        if (descriptor === undefined) continue;
        // React reads array index accessors while rendering the collection. We
        // must opt this array into the lazy transformed view without invoking
        // user code during prop classification.
        if (!("value" in descriptor)) return true;
        pending.push(descriptor.value);
      }
      for (const [, descriptor] of getOptimisticContainerDataProperties(
        entry,
        (property) => property !== "length" && !isArrayIndexProperty(property),
      )) {
        pending.push(descriptor.value);
      }
      continue;
    }
    if (entry instanceof Map) {
      for (const [key, item] of Map.prototype.entries.call(entry) as IterableIterator<
        [unknown, unknown]
      >) {
        pending.push(key, item);
      }
      for (const [, descriptor] of getOptimisticContainerDataProperties(entry, () => true)) {
        pending.push(descriptor.value);
      }
      continue;
    }
    if (entry instanceof Set) return true;
    if (readLazilyTransformableOptimisticIterable(entry) !== null) return true;
    const record = readPlainOptimisticRecord(entry);
    if (record !== null) {
      for (const [, descriptor] of getOptimisticRecordDataEntries(record)) {
        pending.push(descriptor.value);
      }
    }
  }
  return false;
}

type OptimisticThenableSlot = "reason" | "status" | "value";

function defineOptimisticThenableSlot(
  target: object,
  source: object,
  property: OptimisticThenableSlot,
  slotValue: unknown,
  preserveSourceDescriptor: boolean,
): void {
  if (Object.getOwnPropertyDescriptor(target, property)?.configurable === false) return;
  const sourceDescriptor = Object.getOwnPropertyDescriptor(source, property);
  const descriptor =
    preserveSourceDescriptor && sourceDescriptor !== undefined && "value" in sourceDescriptor
      ? { ...sourceDescriptor, value: slotValue }
      : {
          configurable: true,
          enumerable: sourceDescriptor?.enumerable ?? true,
          value: slotValue,
          writable: true,
        };
  Object.defineProperty(target, property, descriptor);
}

function preserveOptimisticThenableIntegrity(source: object, target: object): void {
  if (Object.isFrozen(source)) {
    Object.freeze(target);
  } else if (Object.isSealed(source)) {
    Object.seal(target);
  } else if (!Object.isExtensible(source)) {
    Object.preventExtensions(target);
  }
}

function finalizeFulfilledOptimisticThenable(
  source: object,
  target: object,
  transformedValue: unknown,
): void {
  defineOptimisticThenableSlot(target, source, "status", "fulfilled", true);
  defineOptimisticThenableSlot(target, source, "value", transformedValue, true);
  const reasonDescriptor = Object.getOwnPropertyDescriptor(source, "reason");
  if (reasonDescriptor === undefined) {
    Reflect.deleteProperty(target, "reason");
  } else {
    defineOptimisticThenableSlot(
      target,
      source,
      "reason",
      "value" in reasonDescriptor ? reasonDescriptor.value : undefined,
      true,
    );
  }
  preserveOptimisticThenableIntegrity(source, target);
}

function createOptimisticNativePromiseView(
  value: Promise<unknown>,
  transformResolved: (resolved: unknown) => unknown,
  fulfilledValue: unknown,
  deferFulfilledValue: boolean,
): Promise<unknown> {
  const sourceStatus = Reflect.get(value, "status");
  let hasTransformedResolution = sourceStatus === "fulfilled" && !deferFulfilledValue;
  let transformedResolution = fulfilledValue;
  let view: Promise<unknown>;
  const trackFulfilled = (transformed: unknown): void => {
    Reflect.set(view, "status", "fulfilled");
    Reflect.set(view, "value", transformed);
  };
  const trackRejected = (reason: unknown): void => {
    Reflect.set(view, "status", "rejected");
    Reflect.set(view, "reason", reason);
  };
  view = value.then(
    (resolved) => {
      const transformed = hasTransformedResolution
        ? transformedResolution
        : transformResolved(resolved);
      hasTransformedResolution = true;
      transformedResolution = transformed;
      trackFulfilled(transformed);
      return transformed;
    },
    (reason: unknown) => {
      trackRejected(reason);
      throw reason;
    },
  );

  for (const property of Reflect.ownKeys(value)) {
    if (property === "then" || property === "catch" || property === "finally") continue;
    if (property === "status" || property === "value" || property === "reason") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, property);
    if (descriptor === undefined) continue;
    if (Object.getOwnPropertyDescriptor(view, property)?.configurable === false) continue;
    void Object.defineProperty(view, property, descriptor);
  }
  for (const [property, slotValue] of [
    [
      "status",
      sourceStatus === "fulfilled" || sourceStatus === "rejected" ? sourceStatus : "pending",
    ],
    ["value", sourceStatus === "fulfilled" && !deferFulfilledValue ? fulfilledValue : undefined],
    ["reason", sourceStatus === "rejected" ? Reflect.get(value, "reason") : undefined],
  ] as const) {
    defineOptimisticThenableSlot(
      view,
      value,
      property,
      slotValue,
      sourceStatus === "fulfilled" && !deferFulfilledValue,
    );
  }

  const finalizeFulfilledValue = (transformed: unknown): void => {
    transformedResolution = transformed;
    hasTransformedResolution = true;
    trackFulfilled(transformed);
    if (sourceStatus === "fulfilled") {
      finalizeFulfilledOptimisticThenable(value, view, transformed);
    }
  };
  optimisticThenableViewFinalizers.set(view, finalizeFulfilledValue);
  if (sourceStatus === "fulfilled" && !deferFulfilledValue) {
    finalizeFulfilledValue(fulfilledValue);
  }
  if (sourceStatus !== "fulfilled" && !Object.isExtensible(value)) {
    void Object.preventExtensions(view);
  }
  return view;
}

function createOptimisticThenableView(
  value: Promise<unknown>,
  transformResolved: (resolved: unknown) => unknown,
  fulfilledValue?: unknown,
  deferFulfilledValue = false,
): Promise<unknown> {
  if (value instanceof Promise) {
    return createOptimisticNativePromiseView(
      value,
      transformResolved,
      fulfilledValue,
      deferFulfilledValue,
    );
  }
  const originalThen = Reflect.get(value, "then") as (...args: unknown[]) => unknown;
  const sourceStatus = Reflect.get(value, "status");
  const target = Object.create(Object.getPrototypeOf(value)) as object;
  for (const property of Reflect.ownKeys(value)) {
    if (property === "then" || property === "catch" || property === "finally") continue;
    if (property === "status" || property === "value" || property === "reason") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, property);
    if (descriptor === undefined) continue;
    Object.defineProperty(target, property, descriptor);
  }
  for (const [property, slotValue] of [
    [
      "status",
      sourceStatus === "fulfilled" || sourceStatus === "rejected" ? sourceStatus : "pending",
    ],
    ["value", sourceStatus === "fulfilled" && !deferFulfilledValue ? fulfilledValue : undefined],
    ["reason", sourceStatus === "rejected" ? Reflect.get(value, "reason") : undefined],
  ] as const) {
    defineOptimisticThenableSlot(
      target,
      value,
      property,
      slotValue,
      sourceStatus === "fulfilled" && !deferFulfilledValue,
    );
  }

  const trackFulfilled = (transformed: unknown): void => {
    Reflect.set(target, "status", "fulfilled");
    Reflect.set(target, "value", transformed);
  };
  const trackRejected = (reason: unknown): void => {
    Reflect.set(target, "status", "rejected");
    Reflect.set(target, "reason", reason);
  };
  let hasTransformedResolution = sourceStatus === "fulfilled" && !deferFulfilledValue;
  let transformedResolution = fulfilledValue;
  const transformedThen = (onFulfilled?: unknown, onRejected?: unknown): unknown =>
    Reflect.apply(originalThen, value, [
      (resolved: unknown) => {
        const transformed = hasTransformedResolution
          ? transformedResolution
          : transformResolved(resolved);
        hasTransformedResolution = true;
        transformedResolution = transformed;
        trackFulfilled(transformed);
        return typeof onFulfilled === "function"
          ? Reflect.apply(onFulfilled, undefined, [transformed])
          : transformed;
      },
      (reason: unknown) => {
        trackRejected(reason);
        if (typeof onRejected === "function") {
          return Reflect.apply(onRejected, undefined, [reason]);
        }
        throw reason;
      },
    ]);
  const catchMethod = (onRejected?: unknown): unknown => transformedThen(undefined, onRejected);
  let view: Promise<unknown>;
  const finallyMethod = (onFinally?: unknown): Promise<unknown> =>
    Promise.resolve(view).finally(onFinally as () => void);
  const defineMethod = (property: "catch" | "finally" | "then", method: unknown): void => {
    const sourceDescriptor = Object.getOwnPropertyDescriptor(value, property);
    const descriptor: PropertyDescriptor = {
      configurable: sourceDescriptor?.configurable ?? true,
      enumerable: sourceDescriptor?.enumerable ?? false,
    };
    if (sourceDescriptor !== undefined && "get" in sourceDescriptor) {
      descriptor.get = () => method;
      const sourceSetter = Reflect.get(sourceDescriptor, "set") as
        | ((next: unknown) => void)
        | undefined;
      descriptor.set =
        sourceSetter === undefined
          ? undefined
          : function setOptimisticMethod(this: object, next: unknown): void {
              Reflect.apply(sourceSetter, this, [next]);
            };
    } else {
      descriptor.value = method;
      descriptor.writable = sourceDescriptor?.writable ?? true;
    }
    Object.defineProperty(target, property, descriptor);
  };
  defineMethod("then", transformedThen);
  defineMethod("catch", catchMethod);
  defineMethod("finally", finallyMethod);

  const boundMethods = new Map<PropertyKey, (...args: unknown[]) => unknown>();
  view = new Proxy(target, {
    get(proxyTarget, property) {
      const ownDescriptor = Object.getOwnPropertyDescriptor(proxyTarget, property);
      if (ownDescriptor !== undefined) {
        return Reflect.get(proxyTarget, property, proxyTarget);
      }
      const sourceObject = value as unknown as object;
      const sourceResult = Reflect.get(sourceObject, property, sourceObject);
      if (typeof sourceResult !== "function") return sourceResult;
      let bound = boundMethods.get(property);
      if (bound === undefined) {
        bound = (...args: unknown[]) => Reflect.apply(sourceResult, sourceObject, args);
        boundMethods.set(property, bound);
      }
      return bound;
    },
    set(proxyTarget, property, next) {
      return Reflect.set(proxyTarget, property, next, proxyTarget);
    },
  }) as unknown as Promise<unknown>;

  const finalizeFulfilledValue = (transformed: unknown): void => {
    transformedResolution = transformed;
    hasTransformedResolution = true;
    trackFulfilled(transformed);
    if (sourceStatus === "fulfilled") {
      finalizeFulfilledOptimisticThenable(value, target, transformed);
    }
  };
  optimisticThenableViewFinalizers.set(view as object, finalizeFulfilledValue);
  if (sourceStatus === "fulfilled" && !deferFulfilledValue) {
    finalizeFulfilledValue(fulfilledValue);
  }
  if (sourceStatus !== "fulfilled" && !Object.isExtensible(value)) {
    Object.preventExtensions(target);
  }
  return view;
}

function createOptimisticIterableView(
  value: object,
  iterable: Iterable<unknown>,
  traversal: OptimisticReactNodeTraversal,
  preserveThenable: boolean,
): object {
  const view = Object.create(Object.getPrototypeOf(value)) as object;
  for (const property of Reflect.ownKeys(value)) {
    if (property === Symbol.iterator) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, property);
    if (descriptor !== undefined) Object.defineProperty(view, property, descriptor);
  }

  const sourceIteratorDescriptor = Object.getOwnPropertyDescriptor(value, Symbol.iterator);
  const optimisticIterator = function* optimisticIterator(): Iterator<unknown> {
    for (const entry of iterable) {
      yield suspendNestedSuspenseBoundaries(entry, traversal, preserveThenable);
    }
  };
  const iteratorDescriptor: PropertyDescriptor = {
    configurable: sourceIteratorDescriptor?.configurable ?? true,
    enumerable: sourceIteratorDescriptor?.enumerable ?? false,
  };
  if (sourceIteratorDescriptor !== undefined && "get" in sourceIteratorDescriptor) {
    iteratorDescriptor.get = () => optimisticIterator;
    const sourceSetter = Reflect.get(sourceIteratorDescriptor, "set") as
      | ((next: unknown) => void)
      | undefined;
    iteratorDescriptor.set =
      sourceSetter === undefined
        ? undefined
        : function setOptimisticIterator(this: object, next: unknown): void {
            Reflect.apply(sourceSetter, this, [next]);
          };
  } else {
    iteratorDescriptor.value = optimisticIterator;
    iteratorDescriptor.writable = sourceIteratorDescriptor?.writable ?? true;
  }
  Object.defineProperty(view, Symbol.iterator, iteratorDescriptor);
  if (!Object.isExtensible(value)) Object.preventExtensions(view);
  return view;
}

type OptimisticContainerDataProperty = [PropertyKey, PropertyDescriptor & { value: unknown }];

function getOptimisticContainerDataProperties(
  source: object,
  shouldCopy: (property: PropertyKey) => boolean,
): OptimisticContainerDataProperty[] {
  const properties: OptimisticContainerDataProperty[] = [];
  for (const property of Reflect.ownKeys(source)) {
    if (!shouldCopy(property)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(source, property);
    if (descriptor !== undefined && "value" in descriptor) {
      properties.push([property, descriptor as PropertyDescriptor & { value: unknown }]);
    }
  }
  return properties;
}

function createOptimisticContainerView(
  source: object,
  fallbackTarget: object,
  shouldCopy: (property: PropertyKey) => boolean,
): { dataProperties: OptimisticContainerDataProperty[]; target: object } {
  const copiedProperties = Reflect.ownKeys(source).flatMap((property) => {
    if (!shouldCopy(property)) return [];
    const descriptor = Object.getOwnPropertyDescriptor(source, property);
    return descriptor === undefined ? [] : ([[property, descriptor]] as const);
  });
  // Do not manufacture subclass instances. A successful zero-argument
  // constructor does not prove that its private state is equivalent to the
  // source instance, and copying only public descriptors can create an object
  // whose brand-specific methods silently observe different state. An honest
  // built-in view preserves all cloneable own data without claiming a brand we
  // cannot clone.
  const target = fallbackTarget;

  const dataProperties: OptimisticContainerDataProperty[] = [];
  for (const [property, descriptor] of copiedProperties) {
    if ("value" in descriptor) {
      dataProperties.push([property, descriptor as PropertyDescriptor & { value: unknown }]);
    } else {
      Object.defineProperty(target, property, descriptor);
    }
  }
  return { dataProperties, target };
}

function isArrayIndexProperty(property: PropertyKey): boolean {
  if (typeof property !== "string" || property === "") return false;
  const index = Number(property);
  return Number.isInteger(index) && index >= 0 && index < 4_294_967_295 && `${index}` === property;
}

function findOptimisticPropertyDescriptor(
  source: object,
  property: PropertyKey,
): PropertyDescriptor | undefined {
  let owner: object | null = source;
  while (owner !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, property);
    if (descriptor !== undefined) return descriptor;
    owner = Object.getPrototypeOf(owner) as object | null;
  }
  return undefined;
}

type OptimisticReactNodeWork =
  | { finish: () => void; kind: "finish" }
  | {
      complete: (transformed: unknown) => void;
      kind: "visit";
      preserveThenable: boolean;
      value: unknown;
    };

function suspendNestedSuspenseBoundaries(
  value: unknown,
  traversal: OptimisticReactNodeTraversal = { transformed: new WeakMap() },
  preserveThenable = false,
): unknown {
  let result: unknown;
  const work: OptimisticReactNodeWork[] = [
    {
      complete: (transformed) => {
        result = transformed;
      },
      kind: "visit",
      preserveThenable,
      value,
    },
  ];

  while (work.length > 0) {
    const item = work.pop()!;
    if (item.kind === "finish") {
      item.finish();
      continue;
    }

    const current = item.value;
    const objectValue =
      (typeof current === "object" || typeof current === "function") && current !== null
        ? (current as object)
        : null;
    if (objectValue !== null && traversal.transformed.has(objectValue)) {
      item.complete(traversal.transformed.get(objectValue));
      continue;
    }

    if (Array.isArray(current)) {
      const { dataProperties, target } = createOptimisticContainerView(
        current,
        [],
        (property) => property !== "length" && !isArrayIndexProperty(property),
      );
      const next = target as unknown[];
      next.length = current.length;
      traversal.transformed.set(current, next);
      let changed = false;
      work.push({
        finish: () => {
          const lengthDescriptor = Object.getOwnPropertyDescriptor(current, "length");
          if (lengthDescriptor !== undefined) {
            Object.defineProperty(next, "length", lengthDescriptor);
          }
          const transformed = changed ? next : current;
          traversal.transformed.set(current, transformed);
          if (changed && !Object.isExtensible(current)) Object.preventExtensions(next);
          item.complete(transformed);
        },
        kind: "finish",
      });
      for (let index = current.length - 1; index >= 0; index -= 1) {
        const descriptor = findOptimisticPropertyDescriptor(current, `${index}`);
        if (descriptor === undefined) continue;
        if (!("value" in descriptor)) {
          const sourceGetter = Reflect.get(descriptor, "get") as
            | ((this: unknown[]) => unknown)
            | undefined;
          const sourceSetter = Reflect.get(descriptor, "set") as
            | ((this: unknown[], value: unknown) => void)
            | undefined;
          Object.defineProperty(next, `${index}`, {
            configurable: descriptor.configurable,
            enumerable: descriptor.enumerable,
            get:
              sourceGetter === undefined
                ? undefined
                : function getOptimisticArrayEntry(): unknown {
                    return suspendNestedSuspenseBoundaries(
                      Reflect.apply(sourceGetter, current, []),
                      traversal,
                      item.preserveThenable,
                    );
                  },
            set:
              sourceSetter === undefined
                ? undefined
                : function setOptimisticArrayEntry(value: unknown): void {
                    Reflect.apply(sourceSetter, current, [value]);
                  },
          });
          changed = true;
          continue;
        }
        const entry = descriptor.value;
        work.push({
          complete: (transformed) => {
            Object.defineProperty(next, `${index}`, { ...descriptor, value: transformed });
            if (transformed !== entry && !(entry === current && transformed === next)) {
              changed = true;
            }
          },
          kind: "visit",
          preserveThenable: item.preserveThenable,
          value: entry,
        });
      }
      for (let index = dataProperties.length - 1; index >= 0; index -= 1) {
        const [property, descriptor] = dataProperties[index];
        const entry = descriptor.value;
        work.push({
          complete: (transformed) => {
            Object.defineProperty(next, property, { ...descriptor, value: transformed });
            if (transformed !== entry && !(entry === current && transformed === next)) {
              changed = true;
            }
          },
          kind: "visit",
          preserveThenable: item.preserveThenable,
          value: entry,
        });
      }
      continue;
    }

    if (current instanceof Map) {
      const { dataProperties, target } = createOptimisticContainerView(
        current,
        new Map<unknown, unknown>(),
        () => true,
      );
      const next = target as Map<unknown, unknown>;
      traversal.transformed.set(current, next);
      let changed = false;
      const entries = Array.from(
        Map.prototype.entries.call(current) as IterableIterator<[unknown, unknown]>,
      );
      work.push({
        finish: () => {
          const transformed = changed ? next : current;
          traversal.transformed.set(current, transformed);
          if (changed && !Object.isExtensible(current)) Object.preventExtensions(next);
          item.complete(transformed);
        },
        kind: "finish",
      });
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const [key, entry] = entries[index];
        let transformedKey = key;
        let transformedEntry = entry;
        work.push({
          finish: () => {
            Map.prototype.set.call(next, transformedKey, transformedEntry);
            if (
              (transformedKey !== key && !(key === current && transformedKey === next)) ||
              (transformedEntry !== entry && !(entry === current && transformedEntry === next))
            ) {
              changed = true;
            }
          },
          kind: "finish",
        });
        work.push({
          complete: (transformed) => {
            transformedEntry = transformed;
          },
          kind: "visit",
          preserveThenable: item.preserveThenable,
          value: entry,
        });
        work.push({
          complete: (transformed) => {
            transformedKey = transformed;
          },
          kind: "visit",
          preserveThenable: item.preserveThenable,
          value: key,
        });
      }
      for (let index = dataProperties.length - 1; index >= 0; index -= 1) {
        const [property, descriptor] = dataProperties[index];
        const entry = descriptor.value;
        work.push({
          complete: (transformed) => {
            Object.defineProperty(next, property, { ...descriptor, value: transformed });
            if (transformed !== entry && !(entry === current && transformed === next)) {
              changed = true;
            }
          },
          kind: "visit",
          preserveThenable: item.preserveThenable,
          value: entry,
        });
      }
      continue;
    }

    if (current instanceof Set) {
      const { dataProperties, target } = createOptimisticContainerView(
        current,
        new Set<unknown>(),
        () => true,
      );
      const next = target as Set<unknown>;
      traversal.transformed.set(current, next);
      let changed = false;
      const entries = Array.from(Set.prototype.values.call(current) as IterableIterator<unknown>);
      work.push({
        finish: () => {
          const transformed = changed ? next : current;
          traversal.transformed.set(current, transformed);
          if (changed && !Object.isExtensible(current)) Object.preventExtensions(next);
          item.complete(transformed);
        },
        kind: "finish",
      });
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        work.push({
          complete: (transformed) => {
            Set.prototype.add.call(next, transformed);
            if (transformed !== entry && !(entry === current && transformed === next)) {
              changed = true;
            }
          },
          kind: "visit",
          preserveThenable: item.preserveThenable,
          value: entry,
        });
      }
      for (let index = dataProperties.length - 1; index >= 0; index -= 1) {
        const [property, descriptor] = dataProperties[index];
        const entry = descriptor.value;
        work.push({
          complete: (transformed) => {
            Object.defineProperty(next, property, { ...descriptor, value: transformed });
            if (transformed !== entry && !(entry === current && transformed === next)) {
              changed = true;
            }
          },
          kind: "visit",
          preserveThenable: item.preserveThenable,
          value: entry,
        });
      }
      continue;
    }

    if (isOptimisticThenable(current)) {
      const status = Reflect.get(current, "status");
      if (item.preserveThenable) {
        if (status === "rejected") {
          traversal.transformed.set(current as object, current);
          item.complete(current);
          continue;
        }
        if (status !== "fulfilled") {
          const transformed = createOptimisticThenableView(current, (resolved) =>
            suspendNestedSuspenseBoundaries(resolved),
          );
          traversal.transformed.set(current as object, transformed);
          item.complete(transformed);
          continue;
        }
        const fulfilledValue = Reflect.get(current, "value");
        const view = createOptimisticThenableView(current, (resolved) => resolved, undefined, true);
        traversal.transformed.set(current as object, view);
        work.push({
          complete: (transformedValue) => {
            const transformed = transformedValue === fulfilledValue ? current : view;
            if (transformed === view) {
              optimisticThenableViewFinalizers.get(view as object)?.(transformedValue);
            }
            traversal.transformed.set(current as object, transformed);
            item.complete(transformed);
          },
          kind: "visit",
          preserveThenable: false,
          value: fulfilledValue,
        });
        continue;
      }

      const pending = createElement(OptimisticResolvedThenable, { value: current });
      traversal.transformed.set(current as object, pending);
      const fulfilledValue = readFulfilledOptimisticThenable(current);
      if (fulfilledValue === OPTIMISTIC_ROUTE_SEGMENT_SUSPENSE_TRIGGER) {
        item.complete(pending);
        continue;
      }
      work.push({
        complete: (transformed) => {
          traversal.transformed.set(current as object, transformed);
          item.complete(transformed);
        },
        kind: "visit",
        preserveThenable: false,
        value: fulfilledValue,
      });
      continue;
    }

    const lazyNode = readOptimisticLazyNode(current);
    if (lazyNode !== null) {
      const pending = createElement(OptimisticResolvedLazyNode, { value: lazyNode });
      traversal.transformed.set(current as object, pending);
      item.complete(pending);
      continue;
    }

    const iterable = readOptimisticIterable(current);
    if (iterable !== null) {
      const transformableIterable = readLazilyTransformableOptimisticIterable(current);
      const transformed =
        transformableIterable === null
          ? current
          : createOptimisticIterableView(
              current as object,
              transformableIterable,
              traversal,
              item.preserveThenable,
            );
      traversal.transformed.set(current as object, transformed);
      item.complete(transformed);
      continue;
    }

    const record = isValidElement(current) ? null : readPlainOptimisticRecord(current);
    if (record !== null) {
      const transformableEntries = getOptimisticRecordDataEntries(record).filter(([, descriptor]) =>
        isOptimisticReactNodeProp(descriptor.value),
      );
      if (transformableEntries.length === 0) {
        traversal.transformed.set(current as object, current);
        item.complete(current);
        continue;
      }
      const transformedProperties = new Set(transformableEntries.map(([property]) => property));
      const next = Object.create(Object.getPrototypeOf(current)) as Record<string, unknown>;
      for (const property of Reflect.ownKeys(current as object)) {
        if (typeof property === "string" && transformedProperties.has(property)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(current as object, property);
        if (descriptor !== undefined) Object.defineProperty(next, property, descriptor);
      }
      traversal.transformed.set(current as object, next);
      let changed = false;
      work.push({
        finish: () => {
          const transformed = changed ? next : current;
          traversal.transformed.set(current as object, transformed);
          if (changed && !Object.isExtensible(current)) Object.preventExtensions(next);
          item.complete(transformed);
        },
        kind: "finish",
      });
      for (let index = transformableEntries.length - 1; index >= 0; index -= 1) {
        const [property, descriptor] = transformableEntries[index];
        const entry = descriptor.value;
        work.push({
          complete: (transformed) => {
            Object.defineProperty(next, property, { ...descriptor, value: transformed });
            if (transformed !== entry && !(entry === current && transformed === next)) {
              changed = true;
            }
          },
          kind: "visit",
          preserveThenable: true,
          value: entry,
        });
      }
      continue;
    }

    if (!isValidElement(current)) {
      item.complete(current);
      continue;
    }
    const props = Reflect.get(current, "props");
    if (!isUnknownRecord(props)) {
      item.complete(current);
      continue;
    }
    if (current.type === Suspense) {
      const pending = cloneElement(
        current,
        { key: getOptimisticSuspenseBoundaryKey(current) },
        createElement(OptimisticRouteSegment),
      );
      traversal.transformed.set(current, pending);
      work.push({
        complete: (fallback) => {
          const suspended = cloneElement(
            current as ReactElement<Record<string, unknown>>,
            { fallback, key: getOptimisticSuspenseBoundaryKey(current) },
            createElement(OptimisticRouteSegment),
          );
          traversal.transformed.set(current, suspended);
          item.complete(suspended);
        },
        kind: "visit",
        preserveThenable: false,
        value: Reflect.get(props, "fallback"),
      });
      continue;
    }

    traversal.transformed.set(current, current);
    let changedProps: Record<string, unknown> | null = null;
    const propEntries = Object.entries(props).filter(
      ([name, propValue]) => name === "children" || isOptimisticReactNodeProp(propValue),
    );
    work.push({
      finish: () => {
        const transformed = changedProps === null ? current : cloneElement(current, changedProps);
        traversal.transformed.set(current, transformed);
        item.complete(transformed);
      },
      kind: "finish",
    });
    for (let index = propEntries.length - 1; index >= 0; index -= 1) {
      const [name, propValue] = propEntries[index];
      work.push({
        complete: (transformed) => {
          if (transformed === propValue) return;
          changedProps ??= {};
          changedProps[name] = transformed;
        },
        kind: "visit",
        preserveThenable: name !== "children",
        value: propValue,
      });
    }
  }

  return result;
}

export function createOptimisticRouteTemplate(options: {
  allowLoadingShell?: boolean;
  allowSegmentShell?: boolean;
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
  const allowsAuthoritativeShell =
    options.allowLoadingShell === true || options.allowSegmentShell === true;
  if (match === null || (!allowsAuthoritativeShell && !match.route.isDynamic)) return null;
  if (options.interceptionContext !== null) return null;

  const metadata = AppElementsWire.readMetadata(options.elements);
  if (metadata.interception !== null || metadata.interceptionContext !== null) return null;

  const routeElement = options.elements[metadata.routeId];
  // Full-prefetch learning is intentionally heuristic: legacy full prefetches
  // are accepted only when the serialized route subtree still contains a
  // Suspense fallback. Authoritative loading-shell prefetches use the marker
  // check below instead.
  if (!allowsAuthoritativeShell && !elementHasSuspenseFallback(routeElement)) return null;
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
    pageElementIds,
    // A loading-shell response has already stopped at the server's dynamic
    // boundaries, so every serialized page/children element is safe to show.
    // The older full-prefetch heuristic has no such authority and must keep
    // replacing page elements with a suspending placeholder.
    preservePageElements: allowsAuthoritativeShell,
    routeId: match.route.id,
    suspendNestedBoundaries: options.allowSegmentShell === true,
  };
}

export function createOptimisticRouteElements(template: OptimisticRouteTemplate): AppElements {
  const elements: Record<string, AppElementValue> = { ...template.elements };
  if (template.suspendNestedBoundaries) {
    for (const [key, value] of Object.entries(elements)) {
      const kind = AppElementsWire.parseElementKey(key)?.kind;
      if (kind !== "layout" && kind !== "page" && kind !== "slot") continue;
      elements[key] = suspendNestedSuspenseBoundaries(value) as AppElementValue;
    }
    return elements;
  }
  if (template.preservePageElements) return elements;
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

  return {
    elements: createOptimisticRouteElements(template),
    params: resolveOptimisticNavigationParams({
      match,
      routeManifest: options.routeManifest,
      urlParts,
    }),
    template,
  };
}
