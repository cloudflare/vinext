import { cloneElement, createElement, isValidElement, Suspense, type ReactNode } from "react";
import {
  ErrorBoundary,
  ForbiddenBoundary,
  NotFoundBoundary,
  RedirectBoundary,
  UnauthorizedBoundary,
} from "vinext/shims/error-boundary";
import { LayoutSegmentProvider } from "vinext/shims/layout-segment-context";
import { Slot } from "vinext/shims/slot";
import { isUnknownRecord } from "../utils/record.js";
import { stripBasePath } from "../utils/base-path.js";
import { decodeMatchedParams, splitPathnameForRouteMatch } from "../routing/utils.js";
import {
  buildOptimisticRouteTrie,
  matchOptimisticRouteTrie,
  type OptimisticRouteTrieMatch,
  type OptimisticRouteTrieNode as TrieNode,
} from "../routing/optimistic-route-trie.js";
import type {
  BrowserRouteManifest,
  BrowserRouteManifestRoute,
} from "../routing/browser-route-manifest.js";
import { extractRawRoutePatternParams, matchRoutePattern } from "../routing/route-pattern.js";
import {
  createNestedBfcacheSlotSegmentId,
  deriveBfcacheSegmentIdentity,
  isNestedBfcacheSlotSegmentId,
} from "./bfcache-identity.js";
import { stripRscCacheBustingSearchParam, stripRscSuffix } from "./app-rsc-cache-busting.js";
import {
  AppElementsWire,
  APP_BFCACHE_SEGMENT_IDENTITIES_KEY,
  APP_PREFETCH_LOADING_SHELL_MARKER_KEY,
  APP_PREFETCH_LOADING_SHELL_ROUTE_STATE_KEY,
  type AppElementValue,
  type AppElements,
} from "./app-elements.js";
import {
  APP_PAGE_SEGMENT_KEY,
  canonicalizeAppPageParams,
  resolveAppPagePatternStateKey,
  resolveAppPageSemanticSegmentStateKey,
} from "./app-page-segment-state.js";

type OptimisticRouteTrieNode = TrieNode<BrowserRouteManifestRoute>;
type OptimisticRouteMatch = OptimisticRouteTrieMatch<BrowserRouteManifestRoute>;

export type OptimisticRouteTemplate = {
  elements: AppElements;
  mountedSlotsHeader: string | null;
  omittedBfcacheSegmentIds: readonly string[];
  omittedLayoutIds: readonly string[];
  pageElementIds: readonly string[];
  routeId: string;
  /**
   * Route state key a loading shell's own boundaries are keyed by, as the
   * server rendered them for the URL the template was learned from. Null when
   * the shell does not carry them.
   */
  routeStateKey: string | null;
  /** Route state key of the URL the template was learned from. */
  urlRouteStateKey: string;
};

type OptimisticNavigationPayload = {
  elements: AppElements;
  params: Record<string, string | string[]>;
  routeParams: Record<string, string | string[]>;
  template: OptimisticRouteTemplate;
  urlParts: readonly string[];
};

const routeTrieCache = new WeakMap<BrowserRouteManifest, OptimisticRouteTrieNode>();
// Shared never-settling thenable used to suspend optimistic page segments until
// the real RSC payload replaces them.
const OPTIMISTIC_ROUTE_SEGMENT_SUSPENSE_TRIGGER = new Promise<never>(() => {});
const REACT_LAZY_TYPE = Symbol.for("react.lazy");

// With `urlRouteStateKey`, keys the template learned from that URL. Without
// it, keys the route's latest template, which other URLs of the route reuse.
export function getOptimisticRouteTemplateKey(options: {
  interceptionContext: string | null;
  mountedSlotsHeader: string | null;
  routeId: string;
  urlRouteStateKey?: string | null;
}): string {
  const key = `${options.routeId}\0${options.interceptionContext ?? ""}\0${options.mountedSlotsHeader ?? ""}`;
  return options.urlRouteStateKey == null ? key : `${key}\0${options.urlRouteStateKey}`;
}

// A prefetch a template was learned from, keyed by its source key.
type OptimisticRouteTemplateSource = {
  cacheKey: string;
  entry: WeakRef<object>;
  urlTemplateKey: string;
};

// The templates learned for each URL. A URL's template lasts as long as the
// prefetch it was learned from stays in the prefetch cache, and is held by
// that prefetch's entry, so it is freed with the entry however the cache
// drops it. The route's template, its latest one, lasts until the caches are
// cleared, as before, and is reused for any URL of the route without one of
// its own, the URL it was learned from included.
export type OptimisticUrlRouteTemplates = {
  // The source of each URL's latest template, by the URL's template key.
  owners: Map<string, string>;
  sources: Map<string, OptimisticRouteTemplateSource>;
  templates: WeakMap<object, OptimisticRouteTemplate>;
};

export function createOptimisticUrlRouteTemplates(): OptimisticUrlRouteTemplates {
  return { owners: new Map(), sources: new Map(), templates: new WeakMap() };
}

export function setOptimisticUrlRouteTemplate(
  urlTemplates: OptimisticUrlRouteTemplates,
  options: {
    cacheKey: string;
    entry: object;
    sourceKey: string;
    template: OptimisticRouteTemplate;
    urlTemplateKey: string;
  },
): void {
  urlTemplates.templates.set(options.entry, options.template);
  urlTemplates.sources.set(options.sourceKey, {
    cacheKey: options.cacheKey,
    entry: new WeakRef(options.entry),
    urlTemplateKey: options.urlTemplateKey,
  });
  urlTemplates.owners.set(options.urlTemplateKey, options.sourceKey);
}

function readLiveSourceEntry(
  source: OptimisticRouteTemplateSource,
  prefetchCache: ReadonlyMap<string, object>,
): object | undefined {
  const entry = source.entry.deref();
  return entry !== undefined && prefetchCache.get(source.cacheKey) === entry ? entry : undefined;
}

// A URL's template, while the prefetch it was learned from is still the one
// in the cache.
export function readOptimisticUrlRouteTemplate(
  urlTemplates: OptimisticUrlRouteTemplates,
  prefetchCache: ReadonlyMap<string, object>,
  urlTemplateKey: string,
): OptimisticRouteTemplate | undefined {
  const sourceKey = urlTemplates.owners.get(urlTemplateKey);
  const source = sourceKey === undefined ? undefined : urlTemplates.sources.get(sourceKey);
  const entry = source === undefined ? undefined : readLiveSourceEntry(source, prefetchCache);
  return entry === undefined ? undefined : urlTemplates.templates.get(entry);
}

// Forgets each source that has left the cache or been replaced, so a new
// prefetch at its key is learned again. Once a URL's latest template's source
// goes, forgets the URL's other live sources too, so the next learning pass
// relearns its template from one of them.
export function pruneOptimisticUrlRouteTemplates(
  urlTemplates: OptimisticUrlRouteTemplates,
  prefetchCache: ReadonlyMap<string, object>,
): void {
  const { owners, sources } = urlTemplates;
  for (const [sourceKey, source] of sources) {
    if (readLiveSourceEntry(source, prefetchCache) !== undefined) continue;
    sources.delete(sourceKey);
    if (owners.get(source.urlTemplateKey) !== sourceKey) continue;
    owners.delete(source.urlTemplateKey);
    for (const [siblingKey, sibling] of sources) {
      if (sibling.urlTemplateKey === source.urlTemplateKey) sources.delete(siblingKey);
    }
  }
}

export function getOptimisticPrefetchSourceKey(options: {
  cacheKey: string;
  interceptionContext: string | null;
  mountedSlotsHeader: string | null;
}): string {
  return `${options.cacheKey}\0${options.interceptionContext ?? ""}\0${options.mountedSlotsHeader ?? ""}`;
}

function buildRouteTrie(routeManifest: BrowserRouteManifest): OptimisticRouteTrieNode {
  return buildOptimisticRouteTrie(
    routeManifest.segmentGraph.routes.values(),
    import.meta.env.DEV
      ? (existingParamName, part) =>
          console.warn(
            `[vinext] Optimistic route trie found conflicting dynamic segments at the same level: :${existingParamName} vs ${part}`,
          )
      : undefined,
  );
}

function getRouteTrie(routeManifest: BrowserRouteManifest): OptimisticRouteTrieNode {
  const existing = routeTrieCache.get(routeManifest);
  if (existing) return existing;

  const trie = buildRouteTrie(routeManifest);
  routeTrieCache.set(routeManifest, trie);
  return trie;
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
  routeManifest: BrowserRouteManifest;
}): OptimisticRouteMatch | null {
  const urlParts = hrefToRouteParts(options.href, options.basePath);
  if (urlParts === null) return null;

  const match = matchOptimisticRouteTrie(getRouteTrie(options.routeManifest), urlParts.normalized);
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

function resolveUrlRouteStateKey(
  match: OptimisticRouteMatch,
  rawUrlParts: readonly string[],
): string {
  const routeParams = extractRawRoutePatternParams(match.route.patternParts, rawUrlParts);
  canonicalizeAppPageParams(routeParams);
  return resolveAppPagePatternStateKey(match.route.patternParts, routeParams);
}

function resolveOptimisticNavigationParams(options: {
  match: OptimisticRouteMatch;
  rawUrlParts: readonly string[];
  routeManifest: BrowserRouteManifest;
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
  routeManifest: BrowserRouteManifest;
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
  routeManifest: BrowserRouteManifest;
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
  route: Pick<BrowserRouteManifestRoute, "pageId" | "slotIds">,
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

// A loading shell that renders the route's own boundaries keys them by the
// route state the server rendered, which a rewrite can make differ from the
// state of the visible URL.
function getShellRouteStateKey(elements: AppElements): string | null {
  const key = elements[APP_PREFETCH_LOADING_SHELL_ROUTE_STATE_KEY];
  return typeof key === "string" ? key : null;
}

export function createOptimisticRouteTemplate(options: {
  allowLoadingShell?: boolean;
  basePath: string;
  elements: AppElements;
  href: string;
  interceptionContext: string | null;
  mountedSlotsHeader: string | null;
  routeManifest: BrowserRouteManifest;
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
  const urlParts = hrefToRouteParts(options.href, options.basePath);
  if (urlParts === null) return null;

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
    routeStateKey: getShellRouteStateKey(options.elements),
    urlRouteStateKey: resolveUrlRouteStateKey(match, urlParts.raw),
  };
}

const PENDING_LAZY: unique symbol = Symbol("vinext.pendingLazy");
const ignoreSettled = (): void => {};
const MAX_REBIND_DEPTH = 100;

// Flight decodes a deferred row as a lazy element, and a client component's
// type as a lazy until its module loads. Once resolved, the lazy reads
// synchronously; otherwise its initializer throws and this returns
// PENDING_LAZY.
function readLazy(value: unknown, onPending?: (thrown: unknown) => void): unknown {
  if (!isUnknownRecord(value) || Reflect.get(value, "$$typeof") !== REACT_LAZY_TYPE) return value;
  const init = Reflect.get(value, "_init");
  if (typeof init !== "function") return value;
  try {
    return init(Reflect.get(value, "_payload"));
  } catch (thrown) {
    onPending?.(thrown);
    return PENDING_LAZY;
  }
}

// How much of a row the commit renders above the shell's mirrored boundary:
// the route's whole chain, else the app's output outside its own Suspense
// boundaries, which show their fallback instead.
type ShellRowRead = "chain" | "output";

// Reads what a commit renders above the shell's mirrored boundary, and the
// fallback of any Suspense boundary read, which the commit shows. Calls
// `onPending` with what each unread lazy throws, or undefined past the depth
// limit.
function visitUnreadLazies(
  value: unknown,
  read: ShellRowRead,
  onPending: (thrown: unknown) => void,
  depth = 0,
  seen = new Set<object>(),
): void {
  if (depth > MAX_REBIND_DEPTH) {
    onPending(undefined);
    return;
  }
  const resolved = readLazy(value, onPending);
  if (typeof resolved !== "object" || resolved === null || seen.has(resolved)) return;
  seen.add(resolved);
  const visit = (entry: unknown, entryRead: ShellRowRead) =>
    visitUnreadLazies(entry, entryRead, onPending, depth + 1, seen);
  if (Array.isArray(resolved)) {
    for (const entry of resolved) visit(entry, read);
    return;
  }
  if (!isValidElement(resolved)) {
    if (typeof Reflect.get(resolved, "then") === "function") {
      // React renders a promise's value once it has fulfilled. Flight decodes
      // one with its status, and parses its row when it is first awaited, as
      // React awaits it. Any other promise is tracked as React tracks it.
      const thenable = resolved as PromiseLike<unknown>;
      if (typeof Reflect.get(thenable, "status") !== "string") {
        Reflect.set(thenable, "status", "pending");
        thenable.then(
          (value) => {
            if (Reflect.get(thenable, "status") !== "pending") return;
            Reflect.set(thenable, "status", "fulfilled");
            Reflect.set(thenable, "value", value);
          },
          (reason: unknown) => {
            if (Reflect.get(thenable, "status") !== "pending") return;
            Reflect.set(thenable, "status", "rejected");
            Reflect.set(thenable, "reason", reason);
          },
        );
      } else if (Reflect.get(thenable, "status") !== "fulfilled") {
        thenable.then(ignoreSettled, ignoreSettled);
      }
      const status = Reflect.get(thenable, "status");
      if (status === "fulfilled") visit(Reflect.get(thenable, "value"), read);
      else onPending(status === "rejected" ? Reflect.get(thenable, "reason") : thenable);
      return;
    }
    // A client component renders the elements nested in a prop's plain
    // objects too. Flight's own objects, a promise's chunk say, aren't plain.
    const prototype = Object.getPrototypeOf(resolved);
    if (prototype === Object.prototype || prototype === null) {
      if (read === "output") for (const entry of Object.values(resolved)) visit(entry, read);
    } else if (resolved instanceof Set || resolved instanceof Map) {
      // Flight keeps both, and React renders their entries as children.
      for (const entry of resolved) visit(entry, read);
    } else if (Symbol.iterator in resolved && !ArrayBuffer.isView(resolved)) {
      // React renders an iterator's entries too, but reading one consumes it.
      onPending(undefined);
    }
    return;
  }
  const type = readLazy(resolved.type, onPending);
  const props = Reflect.get(resolved, "props");
  if (!isUnknownRecord(props)) return;
  // A client loading.tsx is a lazy type until its module loads. A fallback is
  // the app's output, in the route's chain too.
  if (type === Suspense) {
    visit(Reflect.get(props, "fallback"), "output");
    if (read === "output") return;
  }
  if (read === "chain") {
    visit(Reflect.get(props, "children"), read);
  } else {
    // A client component renders the elements it is passed in any prop.
    for (const entry of Object.values(props)) visit(entry, read);
  }
}

// The rows a commit renders: the route entry's chain, and the layout,
// template, page and slot entries, each the app's output inside a boundary at
// most. The page is left out of the shell, so its entry is the boundary alone.
function forEachShellRow(
  elements: Readonly<Record<string, unknown>>,
  visit: (value: unknown, read: ShellRowRead) => void,
): void {
  for (const id of Object.keys(elements)) {
    const kind = AppElementsWire.parseElementKey(id)?.kind;
    if (kind === "route") visit(elements[id], "chain");
    else if (kind === "layout" || kind === "template" || kind === "page" || kind === "slot") {
      visit(elements[id], "output");
    }
  }
}

const SETTLE_OPTIMISTIC_ROUTE_ROWS_TIMEOUT_MS = 50;

// Flight parses a row the first time it is read, and a row that renders a
// client component then waits for its module. Reads the entries a loading
// shell mirrors and rebinds until they resolve, so they read synchronously
// when it is committed. The navigation's request waits for this, so a module
// that is slow to load gives up the shell, left pending, rather than holding
// the navigation.
export async function settleOptimisticRouteRows(elements: AppElements): Promise<void> {
  if (elements[APP_PREFETCH_LOADING_SHELL_MARKER_KEY] !== "LoadingBoundary") return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), SETTLE_OPTIMISTIC_ROUTE_ROWS_TIMEOUT_MS);
  });
  try {
    // Each pass reads a level deeper.
    for (let pass = 0; pass <= MAX_REBIND_DEPTH; pass++) {
      const pending: PromiseLike<unknown>[] = [];
      forEachShellRow(elements, (value, read) =>
        visitUnreadLazies(value, read, (thrown) => {
          // A pending lazy throws its thenable; a failed one throws its error.
          if (isUnknownRecord(thrown) && typeof Reflect.get(thrown, "then") === "function") {
            pending.push(thrown as unknown as PromiseLike<unknown>);
          }
        }),
      );
      if (pending.length === 0) return;
      if ((await Promise.race([Promise.allSettled(pending), timeout])) === "timeout") return;
    }
  } finally {
    clearTimeout(timer);
  }
}

// Pairs each segment key of one route state key with the other's, where they
// differ. Both are JSON arrays of per-segment keys for the same route. Returns
// null when a changed key also stays the same at another position (a static
// segment spelled like a dynamic one) or pairs with two keys: bare keys carry
// no position, so the shell can't be keyed for the target.
function createSegmentKeyMap(fromKey: string, toKey: string): Map<string, string> | null {
  const segmentKeys = new Map([[fromKey, toKey]]);
  let from: unknown;
  let to: unknown;
  try {
    from = JSON.parse(fromKey);
    to = JSON.parse(toKey);
  } catch {
    return segmentKeys;
  }
  if (!Array.isArray(from) || !Array.isArray(to) || from.length !== to.length) {
    return segmentKeys;
  }
  const unchanged = new Set<string>();
  for (let index = 0; index < from.length; index++) {
    const segmentKey: unknown = from[index];
    const targetSegmentKey: unknown = to[index];
    if (typeof segmentKey !== "string" || typeof targetSegmentKey !== "string") continue;
    if (segmentKey === targetSegmentKey) {
      unchanged.add(segmentKey);
      continue;
    }
    const paired = segmentKeys.get(segmentKey);
    if (paired !== undefined && paired !== targetSegmentKey) return null;
    segmentKeys.set(segmentKey, targetSegmentKey);
  }
  for (const segmentKey of unchanged) {
    if (segmentKeys.has(segmentKey)) return null;
  }
  return segmentKeys;
}

// What a segment's key gives `useSelectedLayoutSegment()`, as the server
// resolves a LayoutSegmentProvider's segments: a param's value (a dynamic
// segment's key is `name|value|type`), or null for an empty optional
// catch-all, which is left out. A param's name may contain `|`, but its value
// is URL-encoded, so the key is read from its end.
function readSegmentValue(segmentKey: string): string | null {
  const param = /^.+\|([^|]*)\|(d|c|oc)$/s.exec(segmentKey);
  if (param === null) return segmentKey;
  return param[2] === "oc" && param[1] === "" ? null : param[1];
}

// Pairs each changed segment value of one route state key with the other's,
// for the segment maps of layout segment providers, which list the values
// below their layout, route groups included. Returns null when a changed value
// can't be told apart from another segment's, or an optional catch-all gains
// or loses its segments, which shifts a map's positions.
function createSegmentValueMap(fromKey: string, toKey: string): Map<string, string> | null {
  let from: unknown;
  let to: unknown;
  try {
    from = JSON.parse(fromKey);
    to = JSON.parse(toKey);
  } catch {
    return null;
  }
  if (!Array.isArray(from) || !Array.isArray(to) || from.length !== to.length) return null;
  const segmentValues = new Map<string, string>();
  // The page's provider lists the page's own segment, which a param can be
  // spelled like.
  const unchanged = new Set<string>([APP_PAGE_SEGMENT_KEY]);
  for (let index = 0; index < from.length; index++) {
    const segmentKey: unknown = from[index];
    const targetSegmentKey: unknown = to[index];
    if (typeof segmentKey !== "string" || typeof targetSegmentKey !== "string") return null;
    const value = readSegmentValue(segmentKey);
    const targetValue = readSegmentValue(targetSegmentKey);
    if (value === targetValue) {
      if (value !== null) unchanged.add(value);
      continue;
    }
    // A route group is spelled like this, and route state keys leave groups out.
    if (value === null || targetValue === null || /^\(.*\)$/s.test(value)) return null;
    const paired = segmentValues.get(value);
    if (paired !== undefined && paired !== targetValue) return null;
    segmentValues.set(value, targetValue);
  }
  for (const value of unchanged) {
    if (segmentValues.has(value)) return null;
  }
  return segmentValues;
}

// The `children` segments of a layout segment provider's map, for the target.
// Named slots' segments are bound to params of their own, and a shell with
// slot identities is not rebound.
function rebindSegmentMap(
  segmentMap: unknown,
  segmentValues: ReadonlyMap<string, string>,
): unknown {
  if (!isUnknownRecord(segmentMap)) return segmentMap;
  const children = Reflect.get(segmentMap, "children");
  if (!Array.isArray(children)) return segmentMap;
  let changed = false;
  const reboundChildren = children.map((segment: unknown) => {
    const rebound = typeof segment === "string" ? segmentValues.get(segment) : undefined;
    if (rebound === undefined) return segment;
    changed = true;
    return rebound;
  });
  return changed ? { ...segmentMap, children: reboundChildren } : segmentMap;
}

// Element keys and segment identities are built from segment keys, bare or
// nested in JSON arrays: route, template and slot state keys, and identity
// tuples. Swaps the mapped ones and keeps the encoding otherwise.
function rebindSegmentKeys(
  key: string,
  segmentKeys: ReadonlyMap<string, string>,
  depth = 0,
): string {
  const mapped = segmentKeys.get(key);
  if (mapped !== undefined) return mapped;
  if (depth > 8 || !key.startsWith("[")) return key;
  let parsed: unknown;
  try {
    parsed = JSON.parse(key);
  } catch {
    return key;
  }
  if (!Array.isArray(parsed)) return key;
  let changed = false;
  const entries = parsed.map((entry: unknown) => {
    if (typeof entry !== "string") return entry;
    const rebound = rebindSegmentKeys(entry, segmentKeys, depth + 1);
    if (rebound !== entry) changed = true;
    return rebound;
  });
  return changed ? JSON.stringify(entries) : key;
}

const RESET_KEY_BOUNDARY_TYPES: ReadonlySet<unknown> = new Set([
  ErrorBoundary,
  ForbiddenBoundary,
  NotFoundBoundary,
  RedirectBoundary,
  UnauthorizedBoundary,
]);

type SegmentRebinding = {
  keys: ReadonlyMap<string, string>;
  values: ReadonlyMap<string, string>;
};

// Rebinds the keys of vinext's boundaries along the children chain: loading
// boundaries, the slots of templates, and the reset keys of error,
// access-fallback and redirect boundaries, which keep a caught fallback until
// their reset key changes. Layout segment providers get the target's segments.
// With `descend` false, only the top element is rebound, so the app's output
// below it keeps its keys and props. Flags `incomplete` when part of the chain
// can't be read.
function rebindElementKeys(
  value: unknown,
  rebinding: SegmentRebinding,
  descend: boolean,
  incomplete: { found: boolean },
  depth = 0,
): unknown {
  // Past the depth limit, boundaries keyed for the learned URL could remain.
  if (depth > MAX_REBIND_DEPTH) {
    incomplete.found = true;
    return value;
  }
  const resolved = readLazy(value);
  if (resolved === PENDING_LAZY) {
    // Its boundaries can't be read, so they can't be keyed for the target.
    incomplete.found = true;
    return value;
  }
  if (Array.isArray(resolved)) {
    let changed = false;
    const entries = resolved.map((entry) => {
      const rebound = rebindElementKeys(entry, rebinding, descend, incomplete, depth + 1);
      if (rebound !== entry) changed = true;
      return rebound;
    });
    return changed ? entries : value;
  }
  const element = resolved;
  if (!isValidElement(element)) return value;

  const elementProps = Reflect.get(element, "props");
  if (!isUnknownRecord(elementProps)) return value;
  const children = Reflect.get(elementProps, "children");
  const reboundChildren = descend
    ? rebindElementKeys(children, rebinding, descend, incomplete, depth + 1)
    : children;
  const type = readLazy(element.type);
  if (type === PENDING_LAZY) {
    // A key or reset key that names a changed segment may belong to one of
    // vinext's boundaries.
    // So may a segment map that names one.
    const resetKey = Reflect.get(elementProps, "resetKey");
    const segmentMap = Reflect.get(elementProps, "segmentMap");
    if (
      (element.key !== null && rebindSegmentKeys(element.key, rebinding.keys) !== element.key) ||
      (typeof resetKey === "string" && rebindSegmentKeys(resetKey, rebinding.keys) !== resetKey) ||
      rebindSegmentMap(segmentMap, rebinding.values) !== segmentMap
    ) {
      incomplete.found = true;
    }
  }
  const key =
    element.key !== null && (type === Suspense || type === Slot)
      ? rebindSegmentKeys(element.key, rebinding.keys)
      : element.key;
  const resetKey = Reflect.get(elementProps, "resetKey");
  const reboundResetKey =
    typeof resetKey === "string" && RESET_KEY_BOUNDARY_TYPES.has(type)
      ? rebindSegmentKeys(resetKey, rebinding.keys)
      : resetKey;
  const segmentMap = Reflect.get(elementProps, "segmentMap");
  const reboundSegmentMap =
    type === LayoutSegmentProvider ? rebindSegmentMap(segmentMap, rebinding.values) : segmentMap;
  if (
    reboundChildren === children &&
    key === element.key &&
    reboundResetKey === resetKey &&
    reboundSegmentMap === segmentMap
  ) {
    return value;
  }
  const props: Record<string, unknown> = {};
  if (key !== element.key) props.key = key;
  if (reboundResetKey !== resetKey) props.resetKey = reboundResetKey;
  if (reboundSegmentMap !== segmentMap) props.segmentMap = reboundSegmentMap;
  return reboundChildren === children
    ? cloneElement(element, props)
    : cloneElement(element, props, reboundChildren as ReactNode);
}

// Returns null when a loading shell learned from another URL can't be keyed
// for the target.
export function createOptimisticRouteElements(
  template: OptimisticRouteTemplate,
  targetRouteStateKey: string,
): AppElements | null {
  const elements: Record<string, AppElementValue> = { ...template.elements };
  const isLoadingShell =
    template.elements[APP_PREFETCH_LOADING_SHELL_MARKER_KEY] === "LoadingBoundary";
  for (const pageElementId of template.pageElementIds) {
    const pageElement = readLazy(template.elements[pageElementId]);
    // Its boundary can't be mirrored, and a bare suspender in its place would
    // be replaced by the real payload's boundary, remounting the fallback.
    if (isLoadingShell && pageElement === PENDING_LAZY) return null;
    // A loading shell that stops at the route's own loading.tsx mirrors the
    // full render's boundaries: the page entry's own, for a page with one,
    // inside the route entry's. Suspend inside them: the real payload renders
    // the same keyed boundaries, so React keeps the fallback element the
    // optimistic commit mounted.
    elements[pageElementId] =
      isLoadingShell && isValidElement(pageElement) && pageElement.type === Suspense
        ? cloneElement(pageElement, undefined, createElement(OptimisticRouteSegment))
        : createElement(OptimisticRouteSegment);
  }
  const routeStateKey = template.routeStateKey;
  if (routeStateKey !== null) {
    // A row left unread when settling gave up would suspend, or throw, above
    // the boundary the shell mirrors, without its fallback, and so would an
    // unread fallback. The page entries read are the ones committed: the page
    // is left out of the shell, so only its entry's boundary, if any, is read.
    let unread = false;
    forEachShellRow(elements, (value, read) =>
      visitUnreadLazies(value, read, () => {
        unread = true;
      }),
    );
    if (unread) return null;
  }
  if (
    !isLoadingShell ||
    // The target is the URL the shell was rendered for, so its real payload
    // renders the same keys, rewritten or not.
    targetRouteStateKey === template.urlRouteStateKey
  ) {
    return elements;
  }
  if (routeStateKey === null || targetRouteStateKey === routeStateKey) return elements;

  // The shell is keyed for the URL it was learned from, which may be the
  // mounted page. Suspending inside a boundary that already shows its content
  // would hold that page instead of the fallback. Key it for the target
  // instead, as its real payload does: a new route state mounts a fresh
  // boundary the payload then reuses, and a search-only change keeps the
  // mounted one, as in Next.js.
  const segmentKeys = createSegmentKeyMap(routeStateKey, targetRouteStateKey);
  const segmentValues = createSegmentValueMap(routeStateKey, targetRouteStateKey);
  if (segmentKeys === null || segmentValues === null) return null;
  // Segment identities key their slots. The shell renders nothing of the URL
  // in page and template entries (the page is left out, and templates only
  // receive children), so those name the target too. Layouts are rendered
  // with the learned URL's params up to their segment, which their identity is
  // bound to: one bound to a changed segment would, keyed for the target, keep
  // those params, and keyed for the learned URL, sit under boundaries keyed for
  // the target, so the shell is not committed. Named slots bind params of their
  // own, encoded apart from the route state key, so their target identity
  // can't be derived here either.
  const pageElementIds = new Set(template.pageElementIds);
  const { bfcacheSegmentIdentities } = AppElementsWire.readMetadata(template.elements);
  const identities: Record<string, string> = {};
  for (const [id, identity] of Object.entries(bfcacheSegmentIdentities)) {
    const rebound = rebindSegmentKeys(identity, segmentKeys);
    const kind = AppElementsWire.parseElementKey(id)?.kind;
    if (!pageElementIds.has(id) && kind !== "template") {
      if (kind !== "layout" || rebound !== identity) return null;
    }
    identities[id] = rebound;
  }
  // Route entries hold vinext's boundary chain, so all of it is rebound.
  // Page, layout and template entries are the app's output inside a loading
  // boundary at most, so only that boundary is.
  const incomplete = { found: false };
  for (const id of Object.keys(elements)) {
    const kind = AppElementsWire.parseElementKey(id)?.kind;
    if (kind === "route" || kind === "layout" || kind === "template" || pageElementIds.has(id)) {
      elements[id] = rebindElementKeys(
        elements[id],
        { keys: segmentKeys, values: segmentValues },
        kind === "route",
        incomplete,
      ) as AppElementValue;
    }
  }
  if (incomplete.found) return null;
  if (Object.keys(identities).length > 0) {
    elements[APP_BFCACHE_SEGMENT_IDENTITIES_KEY] = identities;
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
  routeManifest: BrowserRouteManifest;
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
  routeManifest: BrowserRouteManifest;
  templates: Pick<ReadonlyMap<string, OptimisticRouteTemplate>, "get">;
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

  const targetRouteStateKey = resolveUrlRouteStateKey(match, urlParts.raw);
  const templateKey = {
    interceptionContext: options.interceptionContext,
    mountedSlotsHeader: options.mountedSlotsHeader,
    routeId: match.route.id,
  };
  // A shell learned from the target itself was rendered for its params, as
  // Next.js commits a URL's own prefetched shell. Other URLs of the route
  // reuse its latest one, keyed for them.
  const template =
    options.templates.get(
      getOptimisticRouteTemplateKey({ ...templateKey, urlRouteStateKey: targetRouteStateKey }),
    ) ?? options.templates.get(getOptimisticRouteTemplateKey(templateKey));
  if (template === undefined) return null;
  if (template.mountedSlotsHeader !== options.mountedSlotsHeader) return null;

  const { navigationParams, routeParams } = resolveOptimisticNavigationParams({
    match,
    rawUrlParts: urlParts.raw,
    routeManifest: options.routeManifest,
    urlParts: urlParts.normalized,
  });
  const elements = createOptimisticRouteElements(template, targetRouteStateKey);
  if (elements === null) return null;
  return {
    elements,
    params: navigationParams,
    routeParams,
    template,
    urlParts: urlParts.normalized,
  };
}
