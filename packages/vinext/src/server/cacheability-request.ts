import type { ExecutionContextLike } from "vinext/shims/request-context";
import {
  CACHEABILITY_REQUEST_STATE,
  type RouteCacheabilityOutcome,
  type RouteCacheabilityState,
} from "vinext/shims/cacheability-classification";
import { applyCdnResponseHeaders, NO_STORE_CACHE_CONTROL } from "./cache-control.js";
import { VINEXT_CACHEABILITY_PROBE_HEADER, VINEXT_PRERENDER_SECRET_HEADER } from "./headers.js";
import { workerCapabilityMatches } from "./worker-prerender-discovery.js";
import {
  CACHEABILITY_PROBE_BODY_LIMIT,
  CACHEABILITY_PROBE_TIMEOUT_MS,
} from "./cacheability-limits.js";
import {
  cacheabilityRequestIdentity,
  findCacheabilityManifestRoute,
  parseCacheabilityManifest,
  type CacheabilityManifest,
  type CacheabilityManifestRoute,
} from "./cacheability-manifest.js";

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

let cachedManifest:
  | { buildId: string; manifest: CacheabilityManifest | null; raw: string }
  | undefined;

function readBoundManifest(raw: string, buildId: string): CacheabilityManifest | null {
  if (cachedManifest?.raw === raw && cachedManifest.buildId === buildId) {
    return cachedManifest.manifest;
  }
  const manifest = parseCacheabilityManifest(raw, buildId);
  cachedManifest = { buildId, manifest, raw };
  return manifest;
}

export function createWorkerCacheabilityAdmissionContext(
  base: ExecutionContextLike,
  request: Request,
  rawManifest: string | null | undefined,
  buildId: string | null | undefined,
): ExecutionContextLike {
  if (!rawManifest || !buildId) return base;
  const manifest = readBoundManifest(rawManifest, buildId);
  const identity = cacheabilityRequestIdentity(request);
  if (!manifest || !identity) return base;

  const state: RouteCacheabilityState = {
    admission: { manifest, ...identity },
    captureDeadlineAt: Date.now() + CACHEABILITY_PROBE_TIMEOUT_MS,
    mode: "admit",
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

type CapturedAdmissionBody =
  | { body: Uint8Array<ArrayBuffer> | null; kind: "captured" }
  | { body: ReadableStream<Uint8Array>; kind: "fallback" };

async function readBeforeDeadline<T>(
  promise: Promise<T>,
  deadlineAt: number,
): Promise<{ kind: "timeout" } | { kind: "value"; value: T }> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) return { kind: "timeout" };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ kind: "value" as const, value })),
      new Promise<{ kind: "timeout" }>((resolve) => {
        timeout = setTimeout(() => resolve({ kind: "timeout" }), remaining);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function continueCapturedBody(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  captured: Uint8Array[],
  pendingRead?: Promise<ReadableStreamReadResult<Uint8Array>>,
): ReadableStream<Uint8Array> {
  let index = 0;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    reader.releaseLock();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < captured.length) {
        controller.enqueue(captured[index++]);
        return;
      }
      try {
        const result = await (pendingRead ?? reader.read());
        pendingRead = undefined;
        if (result.done) {
          release();
          controller.close();
        } else {
          controller.enqueue(result.value);
        }
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        release();
      }
    },
  });
}

export async function captureCacheabilityAdmissionBody(
  body: ReadableStream<Uint8Array> | null,
  deadlineAt: number,
  limit = CACHEABILITY_PROBE_BODY_LIMIT,
): Promise<CapturedAdmissionBody> {
  if (!body) return { body: null, kind: "captured" };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const pendingRead = reader.read();
      const deadlineResult = await readBeforeDeadline(pendingRead, deadlineAt);
      if (deadlineResult.kind === "timeout") {
        return {
          body: continueCapturedBody(reader, chunks, pendingRead),
          kind: "fallback",
        };
      }
      const result = deadlineResult.value;
      if (result.done) {
        reader.releaseLock();
        const captured = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          captured.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return { body: captured, kind: "captured" };
      }
      chunks.push(result.value);
      total += result.value.byteLength;
      if (total > limit) {
        return { body: continueCapturedBody(reader, chunks), kind: "fallback" };
      }
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    reader.releaseLock();
    throw error;
  }
}

function responseWithCachePolicy(
  response: Response,
  body: BodyInit | null,
  outcome: RouteCacheabilityOutcome | null,
): Response {
  const headers = new Headers(response.headers);
  applyCdnResponseHeaders(
    headers,
    outcome?.cacheable === true && outcome.cacheControl
      ? { cacheControl: outcome.cacheControl, tags: outcome.tags }
      : { cacheControl: NO_STORE_CACHE_CONTROL },
  );
  return new Response(body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function staticToDynamicResponse(route: CacheabilityManifestRoute): Response {
  const headers = new Headers({ "Content-Type": "text/plain; charset=utf-8" });
  applyCdnResponseHeaders(headers, { cacheControl: NO_STORE_CACHE_CONTROL });
  return new Response(
    `[vinext] Route ${route.pattern} changed from static to dynamic after deployment.`,
    { headers, status: 500 },
  );
}

function cacheabilityEvaluationFailureResponse(route: CacheabilityManifestRoute): Response {
  const headers = new Headers({ "Content-Type": "text/plain; charset=utf-8" });
  applyCdnResponseHeaders(headers, { cacheControl: NO_STORE_CACHE_CONTROL });
  return new Response(`[vinext] Route ${route.pattern} failed during cacheability evaluation.`, {
    headers,
    status: 500,
  });
}

async function finalizeWorkerCacheabilityAdmission(
  response: Response,
  state: RouteCacheabilityState,
): Promise<Response> {
  const admission = state.admission;
  if (!admission || !state.route) return responseWithCachePolicy(response, response.body, null);
  const manifest = admission.manifest as CacheabilityManifest;
  const manifestRoute = findCacheabilityManifestRoute(manifest, state.route.pattern, {
    representation: admission.representation as Parameters<
      typeof findCacheabilityManifestRoute
    >[2]["representation"],
    requestKey: admission.requestKey,
  });
  if (
    !manifestRoute ||
    manifestRoute.state === "dynamic" ||
    manifestRoute.state === "probe-failed" ||
    manifestRoute.status !== response.status ||
    response.status >= 500
  ) {
    return responseWithCachePolicy(response, response.body, null);
  }

  let captured: CapturedAdmissionBody;
  try {
    captured = await captureCacheabilityAdmissionBody(response.body, state.captureDeadlineAt);
  } catch {
    return cacheabilityEvaluationFailureResponse(manifestRoute);
  }
  if (captured.kind === "fallback") {
    return responseWithCachePolicy(response, captured.body, null);
  }

  const outcome = state.completion ? await state.completion : (state.outcome ?? null);
  if (outcome?.cacheable !== true || !outcome.cacheControl) {
    return manifestRoute.state === "static-candidate" &&
      (outcome === null || outcome.dynamicUsage === true)
      ? staticToDynamicResponse(manifestRoute)
      : responseWithCachePolicy(response, captured.body, null);
  }
  return responseWithCachePolicy(response, captured.body, outcome);
}

export async function finalizeWorkerCacheabilityResponse(
  response: Response,
  ctx: ExecutionContextLike,
): Promise<Response> {
  const state = readState(ctx);
  if (!state) return response;

  if (state.mode === "admit") {
    return finalizeWorkerCacheabilityAdmission(response, state);
  }

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
