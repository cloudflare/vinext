import { VINEXT_PRERENDER_ROUTE_PARAMS_HEADER, VINEXT_PRERENDER_SECRET_HEADER } from "./headers.js";
import { isUnknownRecord } from "../utils/record.js";

export type PrerenderRouteParams = Record<string, string | string[]>;

function isPrerenderRouteParams(value: unknown): value is PrerenderRouteParams {
  if (!isUnknownRecord(value)) return false;

  for (const key in value) {
    const param = value[key];
    if (typeof param === "string") continue;
    if (Array.isArray(param) && param.every((item) => typeof item === "string")) continue;
    return false;
  }

  return true;
}

export function serializePrerenderRouteParamsHeader(
  params: PrerenderRouteParams | null,
): string | null {
  if (params === null || Object.keys(params).length === 0) return null;
  return encodeURIComponent(JSON.stringify(params));
}

function parsePrerenderRouteParamsHeader(value: string | null): PrerenderRouteParams | null {
  if (value === null || value === "") return null;

  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(value));
    return isPrerenderRouteParams(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function readTrustedPrerenderRouteParamsFromHeaders(
  headers: Headers,
  expectedSecret?: string,
): PrerenderRouteParams | null {
  if (process.env.VINEXT_PRERENDER !== "1") return null;
  const secret = headers.get(VINEXT_PRERENDER_SECRET_HEADER);
  if (secret === null) return null;
  if (expectedSecret !== undefined && secret !== expectedSecret) return null;
  const header = headers.get(VINEXT_PRERENDER_ROUTE_PARAMS_HEADER);
  if (header === null) return null;
  const params = parsePrerenderRouteParamsHeader(header);
  if (params === null) {
    throw new Error("[vinext] Invalid internal prerender route params header.");
  }
  return params;
}

export function readTrustedPrerenderRouteParams(request: Request): PrerenderRouteParams | null {
  return readTrustedPrerenderRouteParamsFromHeaders(request.headers);
}

export function encodePrerenderRouteParams(
  pattern: string,
  params: PrerenderRouteParams,
): PrerenderRouteParams | null {
  const encoded: PrerenderRouteParams = {};

  for (const part of pattern.split("/").filter(Boolean)) {
    let paramName: string | null = null;
    if (part.startsWith(":") && (part.endsWith("+") || part.endsWith("*"))) {
      paramName = part.slice(1, -1);
    } else if (part.startsWith(":")) {
      paramName = part.slice(1);
    }

    if (paramName === null) continue;
    const value = params[paramName];
    if (Array.isArray(value)) {
      encoded[paramName] = value.map((item) => encodeURIComponent(item));
    } else if (typeof value === "string") {
      encoded[paramName] = encodeURIComponent(value);
    }
  }

  return Object.keys(encoded).length > 0 ? encoded : null;
}
