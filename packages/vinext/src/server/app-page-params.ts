import type { AppPageParams } from "./app-page-boundary.js";

export function getAppPageSegmentParamName(segment: string): string | null {
  if (segment.startsWith("[[...") && segment.endsWith("]]") && segment.length > 7) {
    return segment.slice(5, -2);
  }

  if (segment.startsWith("[...") && segment.endsWith("]") && segment.length > 5) {
    return segment.slice(4, -1);
  }

  if (
    segment.startsWith("[") &&
    segment.endsWith("]") &&
    !segment.includes(".") &&
    segment.length > 2
  ) {
    return segment.slice(1, -1);
  }

  return null;
}

function isEmptyOptionalCatchAll(segment: string, paramValue: string | string[]): boolean {
  return segment.startsWith("[[...") && Array.isArray(paramValue) && paramValue.length === 0;
}

export function resolveAppPageSegmentParamScopeKeys(
  routeSegments: readonly string[] | null | undefined,
  treePosition: number,
): readonly string[] {
  const paramNames: string[] = [];
  const seen = new Set<string>();
  const segments = routeSegments ?? [];
  const end = Math.min(Math.max(treePosition, 0), segments.length);

  for (let index = 0; index < end; index++) {
    const paramName = getAppPageSegmentParamName(segments[index]);
    if (!paramName || seen.has(paramName)) {
      continue;
    }

    seen.add(paramName);
    paramNames.push(paramName);
  }

  return paramNames;
}

export function resolveAppPageSegmentParams(
  routeSegments: readonly string[] | null | undefined,
  treePosition: number,
  matchedParams: AppPageParams,
): AppPageParams {
  const segmentParams: AppPageParams = {};
  const segments = routeSegments ?? [];
  const end = Math.min(Math.max(treePosition, 0), segments.length);

  for (let index = 0; index < end; index++) {
    const segment = segments[index];
    const paramName = getAppPageSegmentParamName(segment);
    if (!paramName) {
      continue;
    }

    const paramValue = matchedParams[paramName];
    if (paramValue === undefined || isEmptyOptionalCatchAll(segment, paramValue)) {
      continue;
    }

    segmentParams[paramName] = paramValue;
  }

  return segmentParams;
}

export function resolveAppPageBranchParams(
  branchSegments: readonly string[],
  treePosition: number,
  matchedParams: AppPageParams,
  scopedSegments: readonly string[] = branchSegments,
): AppPageParams {
  const branchParamNames = new Set(
    branchSegments.map(getAppPageSegmentParamName).filter((name): name is string => name !== null),
  );
  const scopedParams: AppPageParams = {};
  for (const [name, value] of Object.entries(matchedParams)) {
    if (!branchParamNames.has(name)) scopedParams[name] = value;
  }
  Object.assign(
    scopedParams,
    resolveAppPageSegmentParams(scopedSegments, treePosition, matchedParams),
  );
  return scopedParams;
}
