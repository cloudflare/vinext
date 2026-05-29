import type { RouteManifest, RouteManifestInterception } from "../routing/app-route-graph.js";
import { isUnknownRecord } from "../utils/record.js";
import type { AppRouterScrollIntent } from "vinext/shims/app-router-scroll-state";

export type NavigationRuntimeSnapshot = {
  pathname: string;
  searchParams: [string, string][];
};

export type NavigationRuntimeRscChunk = string | [3, string];

export type NavigationRuntimeRscBootstrap = {
  done?: boolean;
  nav?: NavigationRuntimeSnapshot;
  params?: Record<string, string | string[]>;
  rsc: NavigationRuntimeRscChunk[];
};

export type NavigationRuntimeKind = "navigate" | "traverse" | "refresh";

export type NavigationRuntimeHistoryUpdateMode = "push" | "replace";

export type NavigationRuntimeTraversalIntent = {
  direction: "back" | "forward" | "unknown";
  historyState: unknown;
  targetHistoryIndex: number | null;
};

export type NavigationRuntimeNavigate = (
  href: string,
  redirectDepth?: number,
  navigationKind?: NavigationRuntimeKind,
  historyUpdateMode?: NavigationRuntimeHistoryUpdateMode,
  previousNextUrlOverride?: string | null,
  programmaticTransition?: boolean,
  traversalIntent?: NavigationRuntimeTraversalIntent,
  scrollIntent?: AppRouterScrollIntent | null,
) => Promise<void>;

export type NavigationRuntimeFunctions = {
  clearNavigationCaches?: () => void;
  commitHashNavigation?: (
    href: string,
    historyUpdateMode: NavigationRuntimeHistoryUpdateMode,
    scroll: boolean,
  ) => void;
  navigate?: NavigationRuntimeNavigate;
  pingVisibleLinks?: () => void;
};

export type NavigationRuntimeBootstrap = {
  routeManifest: RouteManifest | null;
  rsc: NavigationRuntimeRscBootstrap | undefined;
};

export type NavigationRuntime = {
  bootstrap: NavigationRuntimeBootstrap;
  functions: NavigationRuntimeFunctions;
};

export const NAVIGATION_RUNTIME_SYMBOL_DESCRIPTION = "vinext.navigationRuntime";
export const NAVIGATION_RUNTIME_KEY = Symbol.for(NAVIGATION_RUNTIME_SYMBOL_DESCRIPTION);

const ROUTE_MANIFEST_SEGMENT_GRAPH_MAP_KEYS: readonly string[] = [
  "boundaries",
  "defaults",
  "interceptions",
  "interceptionsBySlotId",
  "layouts",
  "pages",
  "rootBoundaries",
  "routeHandlers",
  "routes",
  "slotBindings",
  "slots",
  "templates",
];

function createNavigationRuntime(): NavigationRuntime {
  return {
    bootstrap: {
      routeManifest: null,
      rsc: undefined,
    },
    functions: {},
  };
}

function readRuntimeWindow(): Window | null {
  if (typeof window === "undefined") return null;
  return window;
}

function isNavigationRuntimeFunctions(value: unknown): value is NavigationRuntimeFunctions {
  if (!isUnknownRecord(value)) return false;
  return (
    isOptionalRuntimeFunction(Reflect.get(value, "clearNavigationCaches")) &&
    isOptionalRuntimeFunction(Reflect.get(value, "commitHashNavigation")) &&
    isOptionalRuntimeFunction(Reflect.get(value, "navigate")) &&
    isOptionalRuntimeFunction(Reflect.get(value, "pingVisibleLinks"))
  );
}

function isNavigationRuntimeRscChunk(value: unknown): value is NavigationRuntimeRscChunk {
  if (typeof value === "string") return true;
  return (
    Array.isArray(value) && value.length === 2 && value[0] === 3 && typeof value[1] === "string"
  );
}

function isNavigationRuntimeSnapshot(value: unknown): value is NavigationRuntimeSnapshot {
  if (!isUnknownRecord(value)) return false;
  const pathname = Reflect.get(value, "pathname");
  const searchParams = Reflect.get(value, "searchParams");
  return (
    typeof pathname === "string" &&
    Array.isArray(searchParams) &&
    searchParams.every(
      (entry): entry is [string, string] =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === "string" &&
        typeof entry[1] === "string",
    )
  );
}

function isNavigationRuntimeParams(value: unknown): value is Record<string, string | string[]> {
  if (!isUnknownRecord(value)) return false;
  return Object.values(value).every(
    (entry) =>
      typeof entry === "string" ||
      (Array.isArray(entry) && entry.every((part) => typeof part === "string")),
  );
}

function isNavigationRuntimeRscBootstrap(value: unknown): value is NavigationRuntimeRscBootstrap {
  if (!isUnknownRecord(value)) return false;
  const done = Reflect.get(value, "done");
  const nav = Reflect.get(value, "nav");
  const params = Reflect.get(value, "params");
  const rsc = Reflect.get(value, "rsc");
  // getNavigationRuntime() runs at bootstrap/read boundaries, not per chunk.
  // Keep full validation here so malformed ambient state is rejected before
  // hydration consumes it instead of caching a stale validation result.
  return (
    (done === undefined || typeof done === "boolean") &&
    (nav === undefined || isNavigationRuntimeSnapshot(nav)) &&
    (params === undefined || isNavigationRuntimeParams(params)) &&
    Array.isArray(rsc) &&
    rsc.every(isNavigationRuntimeRscChunk)
  );
}

function isReadonlyStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNavigationRuntimeInterception(value: unknown): value is RouteManifestInterception {
  if (!isUnknownRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.sourcePattern === "string" &&
    isReadonlyStringArray(value.sourcePatternParts) &&
    typeof value.targetPattern === "string" &&
    isReadonlyStringArray(value.targetPatternParts) &&
    typeof value.slotId === "string" &&
    isNullableString(value.ownerLayoutId) &&
    isNullableString(value.interceptingRouteId) &&
    isNullableString(value.targetRouteId)
  );
}

function isNavigationRuntimeInterceptionArray(
  value: unknown,
): value is readonly RouteManifestInterception[] {
  return Array.isArray(value) && value.every(isNavigationRuntimeInterception);
}

function isNavigationRuntimeRouteManifest(value: unknown): value is RouteManifest {
  if (!isUnknownRecord(value)) return false;
  const graphVersion = Reflect.get(value, "graphVersion");
  const segmentGraph = Reflect.get(value, "segmentGraph");
  if (typeof graphVersion !== "string" || !isUnknownRecord(segmentGraph)) return false;
  const interceptions = Reflect.get(segmentGraph, "interceptions");
  const interceptionsBySlotId = Reflect.get(segmentGraph, "interceptionsBySlotId");
  if (
    !ROUTE_MANIFEST_SEGMENT_GRAPH_MAP_KEYS.every(
      (key) => Reflect.get(segmentGraph, key) instanceof Map,
    ) ||
    !(interceptions instanceof Map) ||
    !(interceptionsBySlotId instanceof Map)
  ) {
    return false;
  }

  for (const interception of interceptions.values()) {
    if (!isNavigationRuntimeInterception(interception)) return false;
  }
  for (const slotInterceptions of interceptionsBySlotId.values()) {
    if (!isNavigationRuntimeInterceptionArray(slotInterceptions)) return false;
  }
  return true;
}

function isNavigationRuntimeBootstrap(value: unknown): value is NavigationRuntimeBootstrap {
  if (!isUnknownRecord(value)) return false;
  const routeManifest = Reflect.get(value, "routeManifest");
  const rsc = Reflect.get(value, "rsc");
  return (
    (routeManifest === null || isNavigationRuntimeRouteManifest(routeManifest)) &&
    (rsc === undefined || isNavigationRuntimeRscBootstrap(rsc))
  );
}

function isNavigationRuntime(value: unknown): value is NavigationRuntime {
  if (!isUnknownRecord(value)) return false;
  if (!("bootstrap" in value) || !("functions" in value)) return false;
  const { bootstrap, functions } = value;
  return isNavigationRuntimeBootstrap(bootstrap) && isNavigationRuntimeFunctions(functions);
}

function isOptionalRuntimeFunction(value: unknown): boolean {
  return value === undefined || typeof value === "function";
}

export function getNavigationRuntime(): NavigationRuntime | null {
  const runtimeWindow = readRuntimeWindow();
  if (runtimeWindow === null) return null;

  const runtime: unknown = Reflect.get(runtimeWindow, NAVIGATION_RUNTIME_KEY);
  return isNavigationRuntime(runtime) ? runtime : null;
}

/**
 * Returns the registered browser runtime, creating it when a window exists.
 * Without a window, callers receive a detached runtime and must retain the
 * returned reference themselves; server calls are intentionally not global.
 */
function ensureNavigationRuntime(): NavigationRuntime {
  const runtimeWindow = readRuntimeWindow();
  if (runtimeWindow === null) {
    return createNavigationRuntime();
  }

  const existingRuntime: unknown = Reflect.get(runtimeWindow, NAVIGATION_RUNTIME_KEY);
  const runtime = isNavigationRuntime(existingRuntime)
    ? existingRuntime
    : createNavigationRuntime();
  Reflect.set(runtimeWindow, NAVIGATION_RUNTIME_KEY, runtime);
  return runtime;
}

export function registerNavigationRuntimeBootstrap(
  bootstrap: Partial<NavigationRuntimeBootstrap>,
): NavigationRuntime {
  const runtime = ensureNavigationRuntime();
  runtime.bootstrap = {
    ...runtime.bootstrap,
    ...bootstrap,
  };
  return runtime;
}

export function registerNavigationRuntimeFunctions(
  functions: Partial<NavigationRuntimeFunctions>,
): NavigationRuntime {
  const runtime = ensureNavigationRuntime();
  runtime.functions = {
    ...runtime.functions,
    ...functions,
  };
  return runtime;
}

export function ensureNavigationRuntimeRscBootstrap(): NavigationRuntimeRscBootstrap {
  const runtime = ensureNavigationRuntime();
  return ensureNavigationRuntimeRscBootstrapForRuntime(runtime);
}

function ensureNavigationRuntimeRscBootstrapForRuntime(
  runtime: NavigationRuntime,
): NavigationRuntimeRscBootstrap {
  const rscBootstrap = runtime.bootstrap.rsc;
  if (rscBootstrap === undefined) {
    const nextRscBootstrap: NavigationRuntimeRscBootstrap = { rsc: [] };
    runtime.bootstrap.rsc = nextRscBootstrap;
    return nextRscBootstrap;
  }

  return rscBootstrap;
}

export function subscribeNavigationRuntimeRscChunk(
  chunk: NavigationRuntimeRscChunk,
): NavigationRuntime {
  const runtime = ensureNavigationRuntime();
  ensureNavigationRuntimeRscBootstrapForRuntime(runtime).rsc.push(chunk);
  return runtime;
}

export function hasAppNavigationRuntime(): boolean {
  return typeof getNavigationRuntime()?.functions.navigate === "function";
}

/**
 * True when the App Router has installed its runtime bootstrap on `window`,
 * which the inline runtime-metadata script does synchronously in `<head>`.
 *
 * This is a stronger early-life signal than `hasAppNavigationRuntime()` — the
 * latter checks for the fully-wired `navigate` function and so returns false
 * during the brief window between HTML parse and the bootstrap module
 * finishing initialization. Code that needs to differentiate App Router from
 * Pages Router *during hydration* (e.g. the Script shim deciding whether the
 * server-side pre-head splice already emitted the inline beforeInteractive
 * tag) should call this instead.
 */
export function hasAppNavigationRuntimeBootstrap(): boolean {
  return getNavigationRuntime() !== null;
}
