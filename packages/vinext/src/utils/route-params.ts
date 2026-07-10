import { isUnknownRecord } from "./record.js";

export type RouteParams = Record<string, string | string[]>;

function isRouteParamValue(value: unknown): value is string | string[] {
  if (typeof value === "string") return true;
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export function isRouteParams(value: unknown): value is RouteParams {
  if (!isUnknownRecord(value)) return false;

  for (const paramValue of Object.values(value)) {
    if (!isRouteParamValue(paramValue)) return false;
  }
  return true;
}
