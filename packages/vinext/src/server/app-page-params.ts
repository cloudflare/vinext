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
