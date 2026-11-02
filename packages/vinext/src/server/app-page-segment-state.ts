import type { AppPageParams } from "./app-page-boundary.js";
import { isCatchAllSegment, isOptionalCatchAllSegment } from "../routing/utils.js";

export const APP_PAGE_SEGMENT_KEY = "__PAGE__";
export const APP_PAGE_DEFAULT_SEGMENT_KEY = "__DEFAULT__";

function isDynamicSegment(segment: string): boolean {
  return segment.startsWith("[") && segment.endsWith("]") && !segment.includes(".");
}

export function isAppPageRouteGroupSegment(segment: string): boolean {
  return segment.startsWith("(") && segment.endsWith(")");
}

type AppPageSegmentParamType = "d" | "c" | "oc";

type AppPageSegmentParam = {
  name: string;
  type: AppPageSegmentParamType;
};

function canonicalizeAppPageParam(value: string): string {
  try {
    return encodeURIComponent(decodeURIComponent(value));
  } catch {
    return value;
  }
}

export function canonicalizeAppPageParams(params: AppPageParams): void {
  for (const key of Object.keys(params)) {
    const value = params[key];
    params[key] = Array.isArray(value)
      ? value.map(canonicalizeAppPageParam)
      : canonicalizeAppPageParam(value);
  }
}

function formatParamSegmentValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value.join("/");
  }
  return value;
}

function readSegmentParam(segment: string): AppPageSegmentParam | null {
  if (isOptionalCatchAllSegment(segment)) {
    return {
      name: segment.slice(5, -2),
      type: "oc",
    };
  }

  if (isCatchAllSegment(segment)) {
    return {
      name: segment.slice(4, -1),
      type: "c",
    };
  }

  if (isDynamicSegment(segment)) {
    return {
      name: segment.slice(1, -1),
      type: "d",
    };
  }

  return null;
}

function formatSegmentStateParamValue(
  param: AppPageSegmentParam,
  params: AppPageParams,
  fallbackSegment: string,
): string {
  const value = params[param.name];

  if (
    param.type === "oc" &&
    (value === undefined || (Array.isArray(value) && value.length === 0))
  ) {
    return "";
  }

  return formatParamSegmentValue(value) ?? fallbackSegment;
}

function resolveSingleSegmentStateKey(segment: string, params: AppPageParams): string {
  const param = readSegmentParam(segment);
  if (!param) {
    return segment;
  }

  return `${param.name}|${formatSegmentStateParamValue(param, params, segment)}|${param.type}`;
}

const SEGMENT_PARAM_TYPES: readonly AppPageSegmentParamType[] = ["d", "c", "oc"];

function formatSegmentParamPattern(param: AppPageSegmentParam): string {
  if (param.type === "oc") return `[[...${param.name}]]`;
  if (param.type === "c") return `[...${param.name}]`;
  return `[${param.name}]`;
}

/**
 * Rebinds segment state keys and BFCache identities resolved with one set of
 * params to another. Keys are JSON arrays of segment keys, nested to any
 * depth, so each whole segment key is compared with the param tokens
 * `resolveSingleSegmentStateKey` produced for the learned params; only those
 * whose value differs are replaced. Returns null when no token changes.
 */
export function createAppPageSegmentStateKeyRebinder(
  fromParams: AppPageParams,
  toParams: AppPageParams,
): ((stateKey: string) => string) | null {
  const tokens = new Map<string, string>();
  for (const name of new Set([...Object.keys(fromParams), ...Object.keys(toParams)])) {
    for (const type of SEGMENT_PARAM_TYPES) {
      const param = { name, type };
      const fallbackSegment = formatSegmentParamPattern(param);
      const from = formatSegmentStateParamValue(param, fromParams, fallbackSegment);
      const to = formatSegmentStateParamValue(param, toParams, fallbackSegment);
      if (from !== to) tokens.set(`${name}|${from}|${type}`, `${name}|${to}|${type}`);
    }
  }
  if (tokens.size === 0) return null;

  const rebind = (stateKey: string): string => {
    const token = tokens.get(stateKey);
    if (token !== undefined) return token;
    if (!stateKey.startsWith("[")) return stateKey;
    let parts: unknown;
    try {
      parts = JSON.parse(stateKey);
    } catch {
      return stateKey;
    }
    if (!Array.isArray(parts)) return stateKey;
    let changed = false;
    const rebound = parts.map((part: unknown) => {
      if (typeof part !== "string") return part;
      const next = rebind(part);
      if (next !== part) changed = true;
      return next;
    });
    return changed ? JSON.stringify(rebound) : stateKey;
  };
  return rebind;
}

export function resolveAppPageChildSegments(
  routeSegments: readonly string[],
  treePosition: number,
  params: AppPageParams,
): string[] {
  const rawSegments = routeSegments.slice(treePosition);
  const resolvedSegments: string[] = [];

  for (const segment of rawSegments) {
    if (isOptionalCatchAllSegment(segment)) {
      const paramName = segment.slice(5, -2);
      const paramValue = params[paramName];
      if (Array.isArray(paramValue) && paramValue.length === 0) {
        continue;
      }
      const resolvedValue = formatParamSegmentValue(paramValue);
      if (resolvedValue !== undefined) {
        resolvedSegments.push(resolvedValue);
      }
      continue;
    }

    if (isCatchAllSegment(segment)) {
      const paramName = segment.slice(4, -1);
      resolvedSegments.push(formatParamSegmentValue(params[paramName]) ?? segment);
      continue;
    }

    if (isDynamicSegment(segment)) {
      const paramName = segment.slice(1, -1);
      resolvedSegments.push(formatParamSegmentValue(params[paramName]) ?? segment);
      continue;
    }

    resolvedSegments.push(segment);
  }

  resolvedSegments.push(APP_PAGE_SEGMENT_KEY);
  return resolvedSegments;
}

export function resolveAppPageSegmentStateKey(
  routeSegments: readonly string[],
  treePosition: number,
  params: AppPageParams,
): string {
  for (const segment of routeSegments.slice(treePosition)) {
    if (!isAppPageRouteGroupSegment(segment)) {
      return resolveSingleSegmentStateKey(segment, params);
    }
  }
  return "";
}

/**
 * A branch segment already resolved by route matching: the interception marker
 * is split off and the param map that binds the segment is chosen. Downstream
 * layers serialise these; they never reparse filesystem interception syntax.
 */
export type AppPageSemanticSegment = Readonly<{
  /** Interception marker this segment carries, or null when it is a plain segment. */
  marker: string | null;
  /** Whether the route's matched params or the slot's own params bind the segment. */
  paramSource: "route" | "slot";
  /** Segment name with any interception marker removed. */
  segment: string;
}>;

export function resolveAppPageSemanticSegmentStateKey(
  semanticSegment: AppPageSemanticSegment,
  params: AppPageParams,
): string {
  const { marker, segment } = semanticSegment;
  if (isAppPageRouteGroupSegment(segment)) return segment;
  const stateKey = resolveSingleSegmentStateKey(segment, params);
  return marker ? JSON.stringify([marker, stateKey]) : stateKey;
}

export function resolveAppPageRouteStateKey(
  routeSegments: readonly string[],
  params: AppPageParams,
): string {
  const statePath: string[] = [];

  for (const segment of routeSegments) {
    if (!isAppPageRouteGroupSegment(segment)) {
      statePath.push(resolveSingleSegmentStateKey(segment, params));
    }
  }

  return statePath.length > 0 ? JSON.stringify(statePath) : "";
}

export function resolveAppPagePatternStateKey(
  patternParts: readonly string[],
  params: AppPageParams,
): string {
  return resolveAppPageRouteStateKey(
    patternParts.map((part) => {
      if (!part.startsWith(":")) return part;
      if (part.endsWith("*")) return `[[...${part.slice(1, -1)}]]`;
      if (part.endsWith("+")) return `[...${part.slice(1, -1)}]`;
      return `[${part.slice(1)}]`;
    }),
    params,
  );
}

export function resolveAppPageTemplateStateKey(
  routeSegments: readonly string[],
  treePosition: number,
  params: AppPageParams,
): string {
  // Route groups are levels of their own, so a template above one keys off the
  // group rather than the first visible segment below it — sibling routes
  // inside the group share the template and keep its state. Next does the same:
  // the template key is `createRouterCacheKey(activeSegment)` for the immediate
  // child segment (`.nextjs-ref` client/components/layout-router.tsx), and
  // group segments are present in the FlightRouterState.
  const end = treePosition < routeSegments.length ? treePosition + 1 : routeSegments.length;
  const statePath = routeSegments
    .slice(0, end)
    .map((segment) => resolveSingleSegmentStateKey(segment, params));
  return statePath.length > 0 ? JSON.stringify(statePath) : "";
}
