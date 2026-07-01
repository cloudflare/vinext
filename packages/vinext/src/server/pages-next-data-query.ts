import { mergeRouteParamsIntoQuery, parseQueryString as parseQuery } from "../utils/query.js";

function queryValuesEqual(
  left: string | string[] | undefined,
  right: string | string[] | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  const leftValues = Array.isArray(left) ? left : [left];
  const rightValues = Array.isArray(right) ? right : [right];
  if (leftValues.length !== rightValues.length) return false;
  return leftValues.every((value, index) => value === rightValues[index]);
}

function getRewriteDerivedQuery(
  routeUrl: string,
  originalRequestSearch: string,
): Record<string, string | string[]> {
  const destinationQuery = parseQuery(routeUrl);
  if (Object.keys(destinationQuery).length === 0) return {};

  const originalQuery = parseQuery(originalRequestSearch);
  const rewriteQuery: Record<string, string | string[]> = {};

  for (const [key, value] of Object.entries(destinationQuery)) {
    if (!queryValuesEqual(value, originalQuery[key])) {
      rewriteQuery[key] = Array.isArray(value) ? [...value] : value;
    }
  }

  return rewriteQuery;
}

export function buildStaticPageNextDataQuery(
  params: Record<string, string | string[]>,
  routeUrl: string,
  originalRequestSearch: string,
): Record<string, string | string[]> {
  return mergeRouteParamsIntoQuery(getRewriteDerivedQuery(routeUrl, originalRequestSearch), params);
}
