import { VINEXT_PRERENDER_ROUTE_PARAMS_HEADER, VINEXT_PRERENDER_SECRET_HEADER } from "./headers.js";
import { isUnknownRecord } from "../utils/record.js";

export type PrerenderRouteParams = Record<string, string | string[]>;

export type PrerenderRouteParamsPayload = {
  fallbackParamNames?: readonly string[];
  params: PrerenderRouteParams;
  routePattern: string;
};

type PrerenderRouteParamsRouteMatch =
  | {
      kind: "exact";
      params: PrerenderRouteParams;
    }
  | {
      fallbackParamNames: readonly string[];
      kind: "fallback-shell";
      params: PrerenderRouteParams;
    };

function isPrerenderRouteParams(value: unknown): value is PrerenderRouteParams {
  if (!isUnknownRecord(value)) return false;

  for (const [, param] of Object.entries(value)) {
    if (typeof param === "string") continue;
    if (Array.isArray(param) && param.every((item) => typeof item === "string")) continue;
    return false;
  }

  return true;
}

function isPrerenderRouteParamsPayload(value: unknown): value is PrerenderRouteParamsPayload {
  if (!isUnknownRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 2 && keys.length !== 3) return false;
  if (
    keys.some((key) => key !== "fallbackParamNames" && key !== "params" && key !== "routePattern")
  ) {
    return false;
  }
  if (
    "fallbackParamNames" in value &&
    (!Array.isArray(value.fallbackParamNames) ||
      !value.fallbackParamNames.every((name) => typeof name === "string"))
  ) {
    return false;
  }
  return (
    typeof value.routePattern === "string" &&
    value.routePattern.startsWith("/") &&
    isPrerenderRouteParams(value.params)
  );
}

// A payload with no dynamic params serializes to `null`, which is
// indistinguishable from an absent header on the read side. This is intentional:
// the only producer, `encodePrerenderRouteParams`, already returns `null` for
// param-less patterns, so an empty-params payload never carries information worth
// propagating. Routes with no dynamic segments need no encoded-render override.
export function serializePrerenderRouteParamsHeader(
  payload: PrerenderRouteParamsPayload | null,
): string | null {
  if (payload === null || Object.keys(payload.params).length === 0) return null;
  return encodeURIComponent(JSON.stringify(payload));
}

function parsePrerenderRouteParamsHeader(value: string | null): PrerenderRouteParamsPayload | null {
  if (value === null || value === "") return null;

  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(value));
    return isPrerenderRouteParamsPayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function readTrustedPrerenderRouteParamsFromHeaders(
  headers: Headers,
  expectedSecret?: string,
): PrerenderRouteParamsPayload | null {
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

// Convenience wrapper for reads that happen AFTER the prerender secret has
// already been verified at the trust boundary. The only entry point that
// receives raw external input, `prod-server`'s `nodeToWebRequest`, calls
// `readTrustedPrerenderRouteParamsFromHeaders` WITH `expectedSecret` and
// re-serializes the validated payload onto a clean header. Every downstream
// reader (the App Router handler) therefore operates on an already-trusted
// request and deliberately omits `expectedSecret`. The `VINEXT_PRERENDER=1`
// gate still ensures this never activates outside the build-time prerender
// phase. Do not call this on unverified external input.
export function readTrustedPrerenderRouteParams(
  request: Request,
): PrerenderRouteParamsPayload | null {
  return readTrustedPrerenderRouteParamsFromHeaders(request.headers);
}

function decodePrerenderRouteParam(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function decodedPrerenderRouteParamEquals(
  prerenderValue: string | string[],
  matchedValue: string | string[],
): boolean {
  if (Array.isArray(prerenderValue) || Array.isArray(matchedValue)) {
    if (!Array.isArray(prerenderValue) || !Array.isArray(matchedValue)) return false;
    if (prerenderValue.length !== matchedValue.length) return false;

    return prerenderValue.every((item, index) => {
      const decoded = decodePrerenderRouteParam(item);
      return decoded !== null && decoded === matchedValue[index];
    });
  }

  const decoded = decodePrerenderRouteParam(prerenderValue);
  return decoded !== null && decoded === matchedValue;
}

export function prerenderRouteParamsPayloadMatchesRoute(
  payload: PrerenderRouteParamsPayload | null,
  routePattern: string,
  params: PrerenderRouteParams,
): payload is PrerenderRouteParamsPayload {
  const match = matchPrerenderRouteParamsPayload(payload, routePattern, params);
  return match?.kind === "exact";
}

function matchPrerenderRouteParamsPayload(
  payload: PrerenderRouteParamsPayload | null,
  routePattern: string,
  params: PrerenderRouteParams,
): PrerenderRouteParamsRouteMatch | null {
  if (payload === null) return null;
  if (payload.routePattern !== routePattern) return null;
  const prerenderParamKeys = Object.keys(payload.params);
  if (prerenderParamKeys.length !== Object.keys(params).length) return null;

  for (const [key, prerenderValue] of Object.entries(payload.params)) {
    const matchedValue = params[key];
    if (matchedValue === undefined) return null;
    if (!decodedPrerenderRouteParamEquals(prerenderValue, matchedValue)) return null;
  }

  if (payload.fallbackParamNames) {
    const routeParamNames = new Set(
      routePattern
        .split("/")
        .filter((part) => part.startsWith(":"))
        .map((part) =>
          part.endsWith("+") || part.endsWith("*") ? part.slice(1, -1) : part.slice(1),
        ),
    );
    const fallbackParamNames = payload.fallbackParamNames.filter(
      (name, index, names) => routeParamNames.has(name) && names.indexOf(name) === index,
    );
    if (fallbackParamNames.length !== payload.fallbackParamNames.length) return null;
    if (fallbackParamNames.length === 0) return null;

    return {
      fallbackParamNames,
      kind: "fallback-shell",
      params: payload.params,
    };
  }

  return { kind: "exact", params: payload.params };
}

export function encodePrerenderRouteParams(
  pattern: string,
  params: PrerenderRouteParams,
  fallbackParamNames?: readonly string[],
): PrerenderRouteParamsPayload | null {
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

  return Object.keys(encoded).length > 0
    ? {
        ...(fallbackParamNames && fallbackParamNames.length > 0 ? { fallbackParamNames } : {}),
        routePattern: pattern,
        params: encoded,
      }
    : null;
}
