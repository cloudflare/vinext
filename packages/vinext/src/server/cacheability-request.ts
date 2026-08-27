import type { ExecutionContextLike } from "vinext/shims/request-context";
import {
  CACHEABILITY_REQUEST_STATE,
  CACHEABILITY_POLICY_HEADERS,
  type RouteCacheabilityOutcome,
  type RouteCacheabilityState,
} from "vinext/shims/cacheability-classification";
import {
  applyCdnResponseBuildIdentityHeaders,
  applyCdnResponseHeaders,
  hasExplicitNonCacheableResponsePolicy,
  isNonCacheableCacheControl,
  NO_STORE_CACHE_CONTROL,
} from "./cache-control.js";
import {
  VINEXT_CACHEABILITY_PROBE_HEADER,
  VINEXT_PRERENDER_SECRET_HEADER,
  VINEXT_RSC_VARY_HEADER,
} from "./headers.js";
import { workerCapabilityMatches } from "./worker-prerender-discovery.js";
import {
  CACHEABILITY_ADMISSION_ISOLATE_BODY_LIMIT,
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
  kind?: "app-page" | "app-route" | "pages-page";
  pattern?: string;
  reason?: string;
  state: CacheabilityProbeRouteState;
  status: number;
  version: 1;
};

const SUPPORTED_CACHEABILITY_VARY_FIELDS = new Set(
  VINEXT_RSC_VARY_HEADER.split(",").map((name) => name.trim().toLowerCase()),
);

function hasUnsupportedCacheabilityVary(headers: Headers): boolean {
  return (headers.get("Vary") ?? "").split(",").some((name) => {
    const normalized = name.trim().toLowerCase();
    return normalized.length > 0 && !SUPPORTED_CACHEABILITY_VARY_FIELDS.has(normalized);
  });
}

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
  requiresCompletedResponseAdmission = rawManifest != null,
): ExecutionContextLike {
  const identity = cacheabilityRequestIdentity(request);
  if (!rawManifest) {
    if (!requiresCompletedResponseAdmission) return base;
    const state: RouteCacheabilityState = {
      admission: identity ? { policy: "runtime", ...identity } : { policy: "deny" },
      captureDeadlineAt: Date.now() + CACHEABILITY_PROBE_TIMEOUT_MS,
      mode: "admit",
    };
    return Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
      [CACHEABILITY_REQUEST_STATE]: state,
    });
  }

  const manifest = buildId ? readBoundManifest(rawManifest, buildId) : null;

  const state: RouteCacheabilityState = {
    admission:
      manifest && identity ? { manifest, policy: "manifest", ...identity } : { policy: "deny" },
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
  return applyCdnResponseBuildIdentityHeaders(
    Response.json(body, {
      headers: { "Cache-Control": NO_STORE_CACHE_CONTROL },
    }),
  );
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
  | { body: ReadableStream<Uint8Array> | null; kind: "captured" }
  | { body: ReadableStream<Uint8Array>; kind: "fallback" };

export type CacheabilityAdmissionCaptureBudget = {
  maxBytes: number;
  reservedBytes: number;
};

const isolateCaptureBudget: CacheabilityAdmissionCaptureBudget = {
  maxBytes: CACHEABILITY_ADMISSION_ISOLATE_BODY_LIMIT,
  reservedBytes: 0,
};

export function createCacheabilityAdmissionCaptureBudget(
  maxBytes: number,
): CacheabilityAdmissionCaptureBudget {
  return { maxBytes, reservedBytes: 0 };
}

type CapturedChunk = { reserved: boolean; value: Uint8Array };

function reserveChunk(budget: CacheabilityAdmissionCaptureBudget, byteLength: number): boolean {
  if (byteLength > budget.maxBytes - budget.reservedBytes) return false;
  budget.reservedBytes += byteLength;
  return true;
}

function releaseChunk(budget: CacheabilityAdmissionCaptureBudget, chunk: CapturedChunk): void {
  if (!chunk.reserved) return;
  chunk.reserved = false;
  budget.reservedBytes -= chunk.value.byteLength;
}

function releaseChunks(
  budget: CacheabilityAdmissionCaptureBudget,
  chunks: CapturedChunk[],
  start = 0,
): void {
  for (let index = start; index < chunks.length; index++) {
    releaseChunk(budget, chunks[index]);
  }
}

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
  captured: CapturedChunk[],
  budget: CacheabilityAdmissionCaptureBudget,
  pendingRead?: Promise<ReadableStreamReadResult<Uint8Array>>,
): ReadableStream<Uint8Array> {
  let index = 0;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    reader.releaseLock();
  };
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (index < captured.length) {
          const chunk = captured[index++];
          controller.enqueue(chunk.value);
          releaseChunk(budget, chunk);
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
          releaseChunks(budget, captured, index);
          release();
        }
      },
    },
    { highWaterMark: 0 },
  );
}

function replayCapturedBody(
  captured: CapturedChunk[],
  budget: CacheabilityAdmissionCaptureBudget,
): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (index >= captured.length) {
          controller.close();
          return;
        }
        const chunk = captured[index++];
        controller.enqueue(chunk.value);
        releaseChunk(budget, chunk);
      },
      cancel() {
        releaseChunks(budget, captured, index);
      },
    },
    { highWaterMark: 0 },
  );
}

export async function captureCacheabilityAdmissionBody(
  body: ReadableStream<Uint8Array> | null,
  deadlineAt: number,
  limit = CACHEABILITY_PROBE_BODY_LIMIT,
  budget = isolateCaptureBudget,
): Promise<CapturedAdmissionBody> {
  if (!body) return { body: null, kind: "captured" };
  const reader = body.getReader();
  const chunks: CapturedChunk[] = [];
  let total = 0;
  try {
    while (true) {
      const pendingRead = reader.read();
      const deadlineResult = await readBeforeDeadline(pendingRead, deadlineAt);
      if (deadlineResult.kind === "timeout") {
        return {
          body: continueCapturedBody(reader, chunks, budget, pendingRead),
          kind: "fallback",
        };
      }
      const result = deadlineResult.value;
      if (result.done) {
        reader.releaseLock();
        return { body: replayCapturedBody(chunks, budget), kind: "captured" };
      }
      const nextTotal = total + result.value.byteLength;
      const withinResponseLimit = nextTotal <= limit;
      const reserved = withinResponseLimit && reserveChunk(budget, result.value.byteLength);
      chunks.push({ reserved, value: result.value });
      total = nextTotal;
      if (!reserved) {
        return { body: continueCapturedBody(reader, chunks, budget), kind: "fallback" };
      }
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    releaseChunks(budget, chunks);
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

function inferFinalAppPageCacheability(
  response: Response,
  state: RouteCacheabilityState,
): RouteCacheabilityOutcome | null {
  if (!state.explicitConfigCachePolicy && !state.frameworkResponseCachePolicy) return null;

  // Config headers run after the framework snapshots its provisional policy.
  // Match Next.js by honoring a later explicit public policy instead of
  // replacing it with the renderer-derived default during admission.
  const changedPolicy = (
    ["cloudflare-cdn-cache-control", "cdn-cache-control", "cache-control"] as const
  ).find((name) => {
    const value = response.headers.get(name);
    return (
      value !== null &&
      (state.explicitConfigCachePolicy || value !== state.frameworkResponseCachePolicy?.[name])
    );
  });
  if (!changedPolicy) return null;

  const cacheControl = response.headers.get(changedPolicy)!;
  if (isNonCacheableCacheControl(cacheControl)) return { cacheable: false };
  const cacheTag = response.headers.get("Cache-Tag");
  return {
    cacheable: true,
    cacheControl,
    ...(cacheTag
      ? {
          tags: cacheTag
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean),
        }
      : {}),
  };
}

function inferPagesPageCacheability(response: Response): RouteCacheabilityOutcome {
  const cacheControl =
    response.headers.get("Cloudflare-CDN-Cache-Control") ??
    response.headers.get("CDN-Cache-Control") ??
    response.headers.get("Cache-Control");
  if (!cacheControl || isNonCacheableCacheControl(cacheControl)) {
    return { cacheable: false };
  }
  const cacheTag = response.headers.get("Cache-Tag");
  return {
    cacheable: true,
    cacheControl,
    ...(cacheTag
      ? {
          tags: cacheTag
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean),
        }
      : {}),
  };
}

function completedRouteOutcome(
  response: Response,
  state: RouteCacheabilityState,
  rendererOutcome: RouteCacheabilityOutcome | null = state.outcome ?? null,
): RouteCacheabilityOutcome | null {
  if (state.forcedDynamicReason) {
    return { cacheable: false, reason: state.forcedDynamicReason };
  }
  if (state.route?.kind === "app-route") return inferPagesPageCacheability(response);
  if (state.route?.kind === "app-page") {
    return inferFinalAppPageCacheability(response, state) ?? rendererOutcome;
  }
  if (state.route?.kind !== "pages-page") return rendererOutcome;
  if (
    response.headers.has("set-cookie") ||
    hasExplicitNonCacheableResponsePolicy(response.headers)
  ) {
    return { cacheable: false };
  }
  // Pages request-time routes (GSSP/GIP) are dynamic by default, but Next.js
  // deliberately honors an explicit public response policy. ASO/config-header
  // responses likewise use the completed policy rather than a hardcoded TTL.
  // Ported from Next.js:
  // test/e2e/getserversideprops/test/index.test.ts
  // test/e2e/app-dir/custom-cache-control/custom-cache-control.test.ts
  const responseOutcome = inferPagesPageCacheability(response);
  return responseOutcome.cacheable ? responseOutcome : (rendererOutcome ?? responseOutcome);
}

function staticToDynamicResponse(route: CacheabilityManifestRoute): Response {
  const headers = new Headers({ "Content-Type": "text/plain; charset=utf-8" });
  applyCdnResponseHeaders(headers, { cacheControl: NO_STORE_CACHE_CONTROL });
  return new Response(
    `[vinext] Route ${route.pattern} changed from static to dynamic after deployment.`,
    { headers, status: 500 },
  );
}

function cacheabilityEvaluationFailureResponse(pattern: string): Response {
  const headers = new Headers({ "Content-Type": "text/plain; charset=utf-8" });
  applyCdnResponseHeaders(headers, { cacheControl: NO_STORE_CACHE_CONTROL });
  return new Response(`[vinext] Route ${pattern} failed during cacheability evaluation.`, {
    headers,
    status: 500,
  });
}

function hasStrictFinalResponseVeto(response: Response, state: RouteCacheabilityState): boolean {
  if (state.finalResponseVetoReason || response.headers.has("set-cookie")) return true;

  for (const name of CACHEABILITY_POLICY_HEADERS) {
    const value = response.headers.get(name);
    if (
      value !== null &&
      value !== state.frameworkResponseCachePolicy?.[name] &&
      isNonCacheableCacheControl(value)
    ) {
      return true;
    }
  }
  return false;
}

async function finalizeWorkerCacheabilityAdmission(
  response: Response,
  state: RouteCacheabilityState,
): Promise<Response> {
  // This layer classifies App Pages only. Hybrid routing can hand the request
  // to Pages Router after admission begins; retain the Pages response and its
  // independently computed cache policy until Pages probing is introduced by
  // its own stack layer.
  if (state.preserveResponseCachePolicy) return response;

  const admission = state.admission;

  // Route Handlers normally prove body completion inside their execution
  // boundary, so the outer Worker does not buffer them a second time. Config
  // headers run later, however, and can make an otherwise dynamic response
  // public. Capture only that unproven final-public case before it can escape.
  // A manifest-bearing deployment must also authorize the exact route/path
  // identity. Normalize HTML-shaped direct navigations to the same Route
  // Handler representation as canonical fetches.
  if (state.route?.kind === "app-route") {
    let manifestRoute: CacheabilityManifestRoute | null = null;
    if (
      !admission ||
      admission.policy === "deny" ||
      !admission.representation ||
      !admission.requestKey
    ) {
      return responseWithCachePolicy(response, response.body, null);
    }
    if (admission.policy === "manifest") {
      const manifest = admission.manifest as CacheabilityManifest;
      const representation =
        admission.representation === "html" ? "app-route" : admission.representation;
      manifestRoute = findCacheabilityManifestRoute(
        manifest,
        state.route.kind,
        state.route.pattern,
        {
          representation: representation as Parameters<
            typeof findCacheabilityManifestRoute
          >[3]["representation"],
          requestKey: admission.requestKey,
        },
      );
    }
    if (
      (admission.policy === "manifest" &&
        (!manifestRoute ||
          manifestRoute.state !== "static-candidate" ||
          manifestRoute.status !== response.status)) ||
      response.status >= 500 ||
      state.forcedDynamicReason ||
      hasStrictFinalResponseVeto(response, state) ||
      hasUnsupportedCacheabilityVary(response.headers)
    ) {
      return responseWithCachePolicy(response, response.body, null);
    }

    const outcome = inferPagesPageCacheability(response);
    if (!outcome.cacheable || !outcome.cacheControl) {
      return responseWithCachePolicy(response, response.body, null);
    }
    if (state.completedResponseBody) return response;

    let captured: CapturedAdmissionBody;
    try {
      captured = await captureCacheabilityAdmissionBody(
        response.body,
        state.captureDeadlineAt,
        CACHEABILITY_PROBE_BODY_LIMIT,
        state.captureBudget ?? isolateCaptureBudget,
      );
    } catch {
      return cacheabilityEvaluationFailureResponse(state.route.pattern);
    }
    if (captured.kind === "fallback") {
      return responseWithCachePolicy(response, captured.body, null);
    }
    return responseWithCachePolicy(response, captured.body, outcome);
  }

  if (
    !admission ||
    admission.policy === "deny" ||
    !admission.representation ||
    !admission.requestKey ||
    !state.route ||
    response.status >= 500
  ) {
    return responseWithCachePolicy(response, response.body, null);
  }
  const representationMatchesRoute =
    state.route.kind === "app-page"
      ? admission.representation === "html" ||
        admission.representation === "rsc-full" ||
        admission.representation === "rsc-loading-shell"
      : admission.representation === "html" || admission.representation === "pages-data";
  if (!representationMatchesRoute) {
    return responseWithCachePolicy(response, response.body, null);
  }

  let manifestRoute: CacheabilityManifestRoute | null = null;
  if (admission.policy === "manifest") {
    const manifest = admission.manifest as CacheabilityManifest;
    manifestRoute = findCacheabilityManifestRoute(manifest, state.route.kind, state.route.pattern, {
      representation: admission.representation as Parameters<
        typeof findCacheabilityManifestRoute
      >[3]["representation"],
      requestKey: admission.requestKey,
    });
    if (
      !manifestRoute ||
      manifestRoute.state === "dynamic" ||
      manifestRoute.state === "probe-failed" ||
      manifestRoute.status !== response.status
    ) {
      return responseWithCachePolicy(response, response.body, null);
    }
  }

  if (state.forcedDynamicReason) {
    return responseWithCachePolicy(response, response.body, null);
  }
  if (hasStrictFinalResponseVeto(response, state)) {
    return responseWithCachePolicy(response, response.body, null);
  }
  if (hasUnsupportedCacheabilityVary(response.headers)) {
    return responseWithCachePolicy(response, response.body, null);
  }

  let captured: CapturedAdmissionBody;
  try {
    captured = await captureCacheabilityAdmissionBody(
      response.body,
      state.captureDeadlineAt,
      CACHEABILITY_PROBE_BODY_LIMIT,
      state.captureBudget ?? isolateCaptureBudget,
    );
  } catch {
    return cacheabilityEvaluationFailureResponse(state.route.pattern);
  }
  if (captured.kind === "fallback") {
    return responseWithCachePolicy(response, captured.body, null);
  }

  const rendererOutcome = state.completion ? await state.completion : (state.outcome ?? null);
  const outcome = completedRouteOutcome(response, state, rendererOutcome);
  if (outcome?.cacheable !== true || !outcome.cacheControl) {
    // Next.js throws a static-to-dynamic error only when the runtime render
    // actually observed dynamic usage. An absent outcome can also mean the
    // renderer deliberately bypassed its cache-write path (notably draft mode
    // and nonce-bearing HTML), in which case the completed response must stay
    // private without being replaced by a 500.
    if (manifestRoute?.state === "static-candidate" && outcome?.dynamicUsage === true) {
      // The replacement 500 does not consume the captured replay stream. Its
      // cancellation releases the isolate-wide byte reservation immediately.
      await captured.body?.cancel().catch(() => {});
      return staticToDynamicResponse(manifestRoute);
    }
    return responseWithCachePolicy(response, captured.body, null);
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
        : { cacheable: false, reason: "request did not resolve to a probeable page route" },
      response.status,
    );
  }

  if (!state.route) {
    await response.body?.cancel().catch(() => {});
    return probeResponse(
      state,
      "probe-failed",
      { cacheable: false, reason: "request did not resolve to a probeable page route" },
      response.status,
    );
  }

  // A private-cache boundary suspends before request-private user code runs.
  // Only that dedicated framework bailout may outrank an internal render
  // status; ordinary dynamic usage must never hide a genuine route 5xx.
  if (state.probeBailout?.kind === "private-cache") {
    await response.body?.cancel().catch(() => {});
    return probeResponse(state, "dynamic", state.probeBailout.outcome, response.status);
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

  const rendererOutcome = state.completion ? await state.completion : (state.outcome ?? null);
  const outcome = completedRouteOutcome(response, state, rendererOutcome);
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
