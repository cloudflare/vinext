import type { ExecutionContextLike } from "vinext/shims/request-context";
import { getRequestExecutionContext } from "vinext/shims/request-context";
import { getCdnCacheAdapter } from "vinext/shims/cdn-cache";
import { applyCdnResponseHeaders, NO_STORE_CACHE_CONTROL } from "./cache-control.js";
import {
  cacheabilityRouteKey,
  getEmbeddedCacheabilityManifest,
  type CacheabilityManifestRoute,
  type CacheabilityRouteKind,
  type CacheabilityRouteState,
} from "./cacheability-manifest.js";
import { VINEXT_CACHEABILITY_PROBE_HEADER, VINEXT_PRERENDER_SECRET_HEADER } from "./headers.js";
import { workerCapabilityMatches } from "./worker-prerender-discovery.js";

type CacheabilityOutcome = {
  cacheControl?: string;
  cacheable: boolean;
  reason?: string;
  tags?: readonly string[];
};

type CacheabilityRequestRoute = Pick<CacheabilityManifestRoute, "kind" | "pattern">;

type CacheabilityRequestState = {
  complete?: (outcome: CacheabilityOutcome) => void;
  completion?: Promise<CacheabilityOutcome>;
  manifestRoute?: CacheabilityManifestRoute;
  mode: "admit" | "admit-all" | "probe";
  outcome?: CacheabilityOutcome;
  route?: CacheabilityRequestRoute;
};

const CACHEABILITY_STATE = Symbol.for("vinext.cacheabilityRequestState");

function readState(ctx: ExecutionContextLike | null | undefined): CacheabilityRequestState | null {
  if (!ctx) return null;
  return (Reflect.get(ctx, CACHEABILITY_STATE) as CacheabilityRequestState | undefined) ?? null;
}

function responsePolicyIsCacheable(response: Response): boolean {
  if (response.status < 200 || response.status >= 400 || response.headers.has("set-cookie")) {
    return false;
  }
  const policy =
    response.headers.get("CDN-Cache-Control") ??
    response.headers.get("Cloudflare-CDN-Cache-Control") ??
    response.headers.get("Cache-Control") ??
    "";
  return (
    policy.length > 0 && !/(?:^|,)\s*(?:no-store|no-cache|private)(?:\s*(?:=|,|$))/i.test(policy)
  );
}

export function createWorkerCacheabilityContext(
  base: ExecutionContextLike,
  request: Request,
  expectedSecret: string | null | undefined,
): ExecutionContextLike {
  const requestedProbe = request.headers.get(VINEXT_CACHEABILITY_PROBE_HEADER) === "1";
  const authorizedProbe =
    requestedProbe &&
    Boolean(expectedSecret) &&
    workerCapabilityMatches(
      request.headers.get(VINEXT_PRERENDER_SECRET_HEADER) ?? "",
      expectedSecret ?? "",
    );
  const manifest = getEmbeddedCacheabilityManifest();
  if (!authorizedProbe && base.hostRuntime !== "worker") return base;

  const state: CacheabilityRequestState = {
    mode: authorizedProbe ? "probe" : manifest ? "admit" : "admit-all",
  };
  return Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
    [CACHEABILITY_STATE]: state,
  });
}

export function beginRouteCacheability(kind: CacheabilityRouteKind, pattern: string): boolean {
  const state = readState(getRequestExecutionContext());
  if (!state) return false;

  // Authenticated probes must observe the route regardless of the configured
  // serving strategy. Ordinary requests only need late edge admission when a
  // CDN owns revalidation; the default KV/data-cache strategy already captures
  // the completed artifact programmatically and must retain streaming parity.
  if (state.mode !== "probe" && getCdnCacheAdapter().ownsBackgroundRevalidation) return false;

  const manifestRoute =
    getEmbeddedCacheabilityManifest()?.routes[cacheabilityRouteKey(kind, pattern)];
  if (state.mode === "admit" && manifestRoute?.state !== "static-candidate") return false;

  state.route = { kind, pattern };
  state.manifestRoute = manifestRoute;
  return true;
}

export function deferRouteCacheability(): ((outcome: CacheabilityOutcome) => void) | null {
  const state = readState(getRequestExecutionContext());
  if (!state?.route || state.completion) return null;

  state.completion = new Promise<CacheabilityOutcome>((resolve) => {
    state.complete = (outcome) => {
      state.outcome = outcome;
      resolve(outcome);
    };
  });
  return (outcome) => state.complete?.(outcome);
}

export function recordRouteCacheability(outcome: CacheabilityOutcome): void {
  const state = readState(getRequestExecutionContext());
  if (!state?.route) return;
  state.outcome = outcome;
  state.complete?.(outcome);
}

function probeResponse(
  state: CacheabilityRequestState,
  routeState: CacheabilityRouteState,
  outcome: CacheabilityOutcome,
  status: number,
): Response {
  const body = {
    cacheControl: outcome.cacheControl,
    kind: state.route?.kind,
    pattern: state.route?.pattern,
    reason: outcome.reason,
    state: routeState,
    status,
    version: 1,
  };
  return new Response(JSON.stringify(body), {
    headers: {
      "Cache-Control": NO_STORE_CACHE_CONTROL,
      "Content-Type": "application/json",
    },
    status: 200,
  });
}

export async function finalizeWorkerCacheabilityResponse(
  response: Response,
  ctx: ExecutionContextLike,
): Promise<Response> {
  const state = readState(ctx);
  if (!state) return response;
  if (!state.route) {
    return state.mode === "probe"
      ? probeResponse(
          state,
          "probe-failed",
          { cacheable: false, reason: "request did not resolve to a probeable route" },
          response.status,
        )
      : response;
  }

  let body: ArrayBuffer | null = null;
  try {
    body = response.body ? await response.arrayBuffer() : null;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (state.mode === "probe") {
      return probeResponse(state, "probe-failed", { cacheable: false, reason }, response.status);
    }
    const headers = new Headers(response.headers);
    applyCdnResponseHeaders(headers, { cacheControl: NO_STORE_CACHE_CONTROL });
    return new Response("Internal Server Error", { headers, status: 500 });
  }

  const outcome = state.completion
    ? await state.completion
    : (state.outcome ?? {
        cacheable: responsePolicyIsCacheable(response),
        cacheControl:
          response.headers.get("CDN-Cache-Control") ??
          response.headers.get("Cache-Control") ??
          undefined,
      });
  const cacheable = outcome.cacheable && response.status >= 200 && response.status < 400;

  if (state.mode === "probe") {
    return probeResponse(
      state,
      cacheable ? "static-candidate" : "dynamic",
      outcome,
      response.status,
    );
  }

  const headers = new Headers(response.headers);
  if (cacheable && outcome.cacheControl) {
    applyCdnResponseHeaders(headers, {
      cacheControl: outcome.cacheControl,
      tags: outcome.tags,
    });
  } else {
    applyCdnResponseHeaders(headers, { cacheControl: NO_STORE_CACHE_CONTROL });
  }
  return new Response(body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}
