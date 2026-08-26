import type { ExecutionContextLike } from "vinext/shims/request-context";
import {
  CACHEABILITY_REQUEST_STATE,
  type RouteCacheabilityOutcome,
  type RouteCacheabilityState,
} from "vinext/shims/cacheability-classification";
import { NO_STORE_CACHE_CONTROL } from "./cache-control.js";
import { VINEXT_CACHEABILITY_PROBE_HEADER, VINEXT_PRERENDER_SECRET_HEADER } from "./headers.js";
import { workerCapabilityMatches } from "./worker-prerender-discovery.js";
import {
  CACHEABILITY_PROBE_BODY_LIMIT,
  CACHEABILITY_PROBE_TIMEOUT_MS,
} from "./cacheability-limits.js";

type CacheabilityProbeRouteState =
  | "dynamic"
  | "probe-failed"
  | "runtime-check"
  | "static-candidate";

type CacheabilityProbeResult = {
  cacheControl?: string;
  kind?: "app-page";
  pattern?: string;
  reason?: string;
  state: CacheabilityProbeRouteState;
  status: number;
  version: 1;
};

export function createWorkerCacheabilityContext(
  base: ExecutionContextLike,
  request: Request,
  expectedSecret: string | null | undefined,
): ExecutionContextLike {
  const requestedMode = request.headers.get(VINEXT_CACHEABILITY_PROBE_HEADER);
  if (requestedMode !== "1" && requestedMode !== "identity") return base;
  if (
    !expectedSecret ||
    !workerCapabilityMatches(
      request.headers.get(VINEXT_PRERENDER_SECRET_HEADER) ?? "",
      expectedSecret,
    )
  ) {
    return base;
  }

  const state: RouteCacheabilityState = {
    captureDeadlineAt: Date.now() + CACHEABILITY_PROBE_TIMEOUT_MS,
    mode: requestedMode === "identity" ? "identity" : "probe",
  };
  return Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
    [CACHEABILITY_REQUEST_STATE]: state,
  });
}

function readState(ctx: ExecutionContextLike): RouteCacheabilityState | null {
  return (
    (Reflect.get(ctx, CACHEABILITY_REQUEST_STATE) as RouteCacheabilityState | undefined) ?? null
  );
}

function probeResponse(
  state: RouteCacheabilityState,
  routeState: CacheabilityProbeRouteState,
  outcome: RouteCacheabilityOutcome,
  status: number,
): Response {
  const body: CacheabilityProbeResult = {
    cacheControl: outcome.cacheControl,
    kind: state.route?.kind,
    pattern: state.route?.pattern,
    reason: outcome.reason,
    state: routeState,
    status,
    version: 1,
  };
  return Response.json(body, {
    headers: { "Cache-Control": NO_STORE_CACHE_CONTROL },
  });
}

async function drainProbeBody(response: Response, deadlineAt: number): Promise<string | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  let total = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    while (true) {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) return "response body did not complete before the probe deadline";
      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("response body did not complete before the probe deadline")),
            remaining,
          );
        }),
      ]);
      if (timeout !== undefined) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      if (result.done) return null;
      total += result.value.byteLength;
      if (total > CACHEABILITY_PROBE_BODY_LIMIT) {
        return `response body exceeded ${CACHEABILITY_PROBE_BODY_LIMIT} bytes`;
      }
    }
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function finalizeWorkerCacheabilityResponse(
  response: Response,
  ctx: ExecutionContextLike,
): Promise<Response> {
  const state = readState(ctx);
  if (!state) return response;

  if (state.mode === "identity") {
    await response.body?.cancel().catch(() => {});
    return probeResponse(
      state,
      state.route ? "runtime-check" : "probe-failed",
      state.route
        ? { cacheable: false }
        : { cacheable: false, reason: "request did not resolve to a probeable App Page" },
      response.status,
    );
  }

  if (!state.route) {
    await response.body?.cancel().catch(() => {});
    return probeResponse(
      state,
      "probe-failed",
      { cacheable: false, reason: "request did not resolve to a probeable App Page" },
      response.status,
    );
  }

  if (response.status >= 500) {
    await response.body?.cancel().catch(() => {});
    return probeResponse(
      state,
      "probe-failed",
      { cacheable: false, reason: `route returned HTTP ${response.status}` },
      response.status,
    );
  }

  const drainFailure = await drainProbeBody(response, state.captureDeadlineAt);
  if (drainFailure) {
    return probeResponse(
      state,
      "probe-failed",
      { cacheable: false, classificationFailure: true, reason: drainFailure },
      response.status,
    );
  }

  const outcome = state.completion ? await state.completion : state.outcome;
  if (!outcome) {
    return probeResponse(
      state,
      "dynamic",
      { cacheable: false, reason: "completed render did not produce a reusable cache policy" },
      response.status,
    );
  }
  return probeResponse(
    state,
    outcome.cacheable
      ? "static-candidate"
      : outcome.classificationFailure
        ? "probe-failed"
        : "dynamic",
    outcome,
    response.status,
  );
}
