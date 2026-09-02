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
  getCdnResponsePolicyHeaderNames,
  hasExplicitNonCacheableResponsePolicy,
  isNonCacheableCacheControl,
  NO_STORE_CACHE_CONTROL,
} from "./cache-control.js";
import {
  VINEXT_CACHEABILITY_PROBE_HEADER,
  VINEXT_CACHEABILITY_PROBE_ROUTE_HEADER,
  VINEXT_PRERENDER_SECRET_HEADER,
  VINEXT_RSC_VARY_HEADER,
} from "./headers.js";
import { workerCapabilityMatches } from "./worker-prerender-discovery.js";
import {
  CACHEABILITY_ADMISSION_ISOLATE_BODY_LIMIT,
  CACHEABILITY_ADMISSION_RESPONSE_BODY_LIMIT,
  CACHEABILITY_PROBE_TIMEOUT_MS,
} from "./cacheability-limits.js";
import {
  cacheabilityManifestRouteState,
  cacheabilityRequestIdentity,
  cacheabilityRoutePathname,
  findCacheabilityManifestRoute,
  parseCacheabilityManifest,
  type CacheabilityManifest,
  type CacheabilityManifestRoute,
  type CacheabilityRouteKind,
  type CacheabilityRepresentation,
} from "./cacheability-manifest.js";
import { applyResponseStagePolicyHeaders } from "./response-stage-policy.js";

type CacheabilityProbeRouteState =
  | "dynamic"
  | "probe-failed"
  | "runtime-check"
  | "static-candidate";

type CacheabilityProbeResult = {
  cacheControl?: string;
  kind?: "app-page" | "app-route" | "pages-api" | "pages-page";
  pattern?: string;
  reason?: string;
  /** The renderer itself completed with a reusable static policy. */
  rendererStatic?: boolean;
  /** Concrete pathname resolved by request-stage routing before rendering. */
  routePathname?: string;
  scope?: "identity" | "pattern";
  state: CacheabilityProbeRouteState;
  status: number;
  /** Routing completed without invoking the reusable response stage. */
  terminal?: true;
  version: 1;
};

const FRAMEWORK_CACHEABILITY_VARY_FIELDS = new Set(
  VINEXT_RSC_VARY_HEADER.split(",").map((name) => name.trim().toLowerCase()),
);

function cacheabilityVaryRejectionReason(
  headers: Headers,
  state: RouteCacheabilityState,
): string | null {
  const fields = (headers.get("Vary") ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  if (fields.includes("*")) return "response uses Vary: *";
  if (state.responseVary === "verbatim") return null;
  return fields.some((name) => !FRAMEWORK_CACHEABILITY_VARY_FIELDS.has(name))
    ? "response cache does not support custom Vary fields"
    : null;
}

export type WorkerCacheabilityProbeMode = "identity" | "probe";

export type WorkerCacheabilityProbeRoute = {
  kind: CacheabilityRouteKind;
  pattern: string;
};

/** Encode the trusted route identity carried by a staged probe request. */
export function serializeWorkerCacheabilityProbeRoute(route: WorkerCacheabilityProbeRoute): string {
  return encodeURIComponent(JSON.stringify([route.kind, route.pattern]));
}

/** Read route identity only after the surrounding probe request is authenticated. */
export function readWorkerCacheabilityProbeRoute(
  request: Request,
): WorkerCacheabilityProbeRoute | null {
  const raw = request.headers.get(VINEXT_CACHEABILITY_PROBE_ROUTE_HEADER);
  if (!raw) return null;
  try {
    const value = JSON.parse(decodeURIComponent(raw)) as unknown;
    if (!Array.isArray(value) || value.length !== 2) return null;
    const [kind, pattern] = value;
    if (
      (kind !== "app-page" && kind !== "app-route" && kind !== "pages-page") ||
      typeof pattern !== "string" ||
      !pattern.startsWith("/")
    ) {
      return null;
    }
    return { kind, pattern };
  } catch {
    return null;
  }
}

/** Authenticate and read the cacheability probe mode before internal headers are filtered. */
export function readWorkerCacheabilityProbeMode(
  request: Request,
  expectedSecret: string | null | undefined,
): WorkerCacheabilityProbeMode | null {
  const requestedMode = request.headers.get(VINEXT_CACHEABILITY_PROBE_HEADER);
  if (requestedMode !== "1" && requestedMode !== "identity") return null;
  if (
    !expectedSecret ||
    !workerCapabilityMatches(
      request.headers.get(VINEXT_PRERENDER_SECRET_HEADER) ?? "",
      expectedSecret,
    )
  ) {
    return null;
  }

  return requestedMode === "identity" ? "identity" : "probe";
}

/** Create probe state from a mode that was authenticated at the request boundary. */
export function createWorkerCacheabilityProbeContext(
  base: ExecutionContextLike,
  mode: WorkerCacheabilityProbeMode,
  responseVary?: "verbatim",
  resolvedRoutePathname?: string,
): ExecutionContextLike {
  const state: RouteCacheabilityState = {
    captureDeadlineAt: Date.now() + CACHEABILITY_PROBE_TIMEOUT_MS,
    mode,
    responsePolicyHeaderNames: [...getCdnResponsePolicyHeaderNames()],
    responseVary,
    resolvedRoutePathname,
  };
  return Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
    [CACHEABILITY_REQUEST_STATE]: state,
  });
}

export function createWorkerCacheabilityContext(
  base: ExecutionContextLike,
  request: Request,
  expectedSecret: string | null | undefined,
  responseVary?: "verbatim",
): ExecutionContextLike {
  const mode = readWorkerCacheabilityProbeMode(request, expectedSecret);
  return mode ? createWorkerCacheabilityProbeContext(base, mode, responseVary) : base;
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
  responseVary?: "verbatim",
  resolvedRoutePathname?: string,
  trustedRepresentation?: CacheabilityRepresentation,
  options?: { applyCompletedResponsePolicy?: boolean },
): ExecutionContextLike {
  const identity = cacheabilityRequestIdentity(request, trustedRepresentation);
  const routePathname = identity
    ? cacheabilityRoutePathname(
        resolvedRoutePathname ?? new URL(request.url).pathname,
        identity.representation,
      )
    : undefined;
  if (!rawManifest) {
    if (!requiresCompletedResponseAdmission) return base;
    const state: RouteCacheabilityState = {
      admission: identity
        ? {
            policy: "runtime",
            ...identity,
            routePathname,
          }
        : { policy: "deny" },
      captureDeadlineAt: Date.now() + CACHEABILITY_PROBE_TIMEOUT_MS,
      mode: "admit",
      applyCompletedResponsePolicy: options?.applyCompletedResponsePolicy,
      responsePolicyHeaderNames: [...getCdnResponsePolicyHeaderNames()],
      responseVary,
    };
    return Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
      [CACHEABILITY_REQUEST_STATE]: state,
    });
  }

  const manifest = buildId ? readBoundManifest(rawManifest, buildId) : null;

  const state: RouteCacheabilityState = {
    admission:
      manifest && identity
        ? {
            manifest,
            policy: "manifest",
            ...identity,
            routePathname,
          }
        : { policy: "deny" },
    captureDeadlineAt: Date.now() + CACHEABILITY_PROBE_TIMEOUT_MS,
    mode: "admit",
    applyCompletedResponsePolicy: options?.applyCompletedResponsePolicy,
    responsePolicyHeaderNames: [...getCdnResponsePolicyHeaderNames()],
    responseVary,
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

function resolveCacheabilityRepresentation(
  representation: CacheabilityRepresentation,
  routeKind: "app-page" | "app-route" | "pages-page",
): CacheabilityRepresentation {
  // Accept describes the representation a caller would prefer; it does not
  // determine whether the resolved pathname belongs to an App Page or a Route
  // Handler. Browser fetch() uses Accept: */* by default, while Route Handlers
  // may legitimately be requested with Accept: text/html. Once routing has
  // resolved the owner, make that result authoritative for non-RSC requests.
  if (representation !== "html" && representation !== "app-route") {
    return representation;
  }
  return routeKind === "app-route" ? "app-route" : "html";
}

/** Apply request-stage-vetted positive config policy inside the admission boundary. */
export function applyResponseStageCachePolicy(
  response: Response,
  ctx: ExecutionContextLike,
  policyHeaders: ReadonlyArray<readonly [string, string]> | null | undefined,
): Response {
  if (!policyHeaders?.length) return response;
  const state = readState(ctx);
  if (state) state.explicitConfigCachePolicy = true;

  try {
    applyResponseStagePolicyHeaders(response.headers, policyHeaders);
    return response;
  } catch {
    const headers = new Headers(response.headers);
    applyResponseStagePolicyHeaders(headers, policyHeaders);
    return new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  }
}

/** Record policy that a renderer applied before producing its response. */
export function recordResponseStageCachePolicy(
  ctx: ExecutionContextLike,
  policyHeaders: ReadonlyArray<readonly [string, string]> | null | undefined,
): void {
  if (!policyHeaders?.length) return;
  const state = readState(ctx);
  if (state) state.explicitConfigCachePolicy = true;
}

function probeResponse(
  state: RouteCacheabilityState,
  routeState: CacheabilityProbeRouteState,
  outcome: RouteCacheabilityOutcome,
  status: number,
  rendererStatic?: boolean,
): Response {
  const body: CacheabilityProbeResult = {
    cacheControl: outcome.cacheControl,
    kind: state.route?.kind,
    pattern: state.route?.pattern,
    reason: outcome.reason,
    ...(rendererStatic !== undefined ? { rendererStatic } : {}),
    ...(state.resolvedRoutePathname ? { routePathname: state.resolvedRoutePathname } : {}),
    ...(routeState === "dynamic"
      ? { scope: state.patternDynamicReason ? ("pattern" as const) : ("identity" as const) }
      : {}),
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

/**
 * Convert an authenticated probe that terminated in request routing into a
 * valid identity-scoped dynamic result. Middleware redirects, custom responses,
 * and external rewrites never reach the reusable response stage.
 */
export function finalizeRequestStageCacheabilityProbe(
  response: Response,
  options: {
    mode: WorkerCacheabilityProbeMode | null;
    responseStageDispatched: boolean;
    route: WorkerCacheabilityProbeRoute | null;
  },
): Response {
  if (!options.mode || options.responseStageDispatched || !options.route) return response;
  void response.body?.cancel().catch(() => {});
  const body: CacheabilityProbeResult = {
    kind: options.route.kind,
    pattern: options.route.pattern,
    reason: "request routing completed without response-stage rendering",
    scope: "identity",
    state: "dynamic",
    status: response.status,
    terminal: true,
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
    }
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    // Cancellation is cleanup, not part of classification. A user stream may
    // return a never-settling cancel promise; do not let it defeat the probe
    // deadline after the body read has already timed out.
    void reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {}
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
    try {
      reader.releaseLock();
    } catch {}
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
      cancel(reason) {
        releaseChunks(budget, captured, index);
        try {
          // A user stream may return a never-settling cancellation promise.
          // Cleanup of the outer request must not wait for it.
          void reader
            .cancel(reason)
            .catch(() => {})
            .finally(release);
        } catch {
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
  limit = CACHEABILITY_ADMISSION_RESPONSE_BODY_LIMIT,
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
    releaseChunks(budget, chunks);
    const release = () => {
      try {
        reader.releaseLock();
      } catch {}
    };
    try {
      const cancellation = reader.cancel(error);
      release();
      void cancellation.catch(() => {}).finally(release);
    } catch {
      release();
    }
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
  const changedPolicy = [...(state.responsePolicyHeaderNames ?? CACHEABILITY_POLICY_HEADERS)]
    .reverse()
    .find((name) => {
      const value = response.headers.get(name);
      return (
        value !== null &&
        (state.explicitConfigCachePolicy || value !== state.frameworkResponseCachePolicy?.[name])
      );
    });
  if (!changedPolicy) return null;

  const cacheControl = response.headers.get(changedPolicy)!;
  if (isNonCacheableCacheControl(cacheControl)) return { cacheable: false };
  return {
    cacheable: true,
    cacheControl,
  };
}

function inferPagesPageCacheability(
  response: Response,
  state: RouteCacheabilityState,
): RouteCacheabilityOutcome {
  const cacheControl = [...(state.responsePolicyHeaderNames ?? CACHEABILITY_POLICY_HEADERS)]
    .reverse()
    .map((name) => response.headers.get(name))
    .find((value) => value !== null);
  if (!cacheControl || isNonCacheableCacheControl(cacheControl)) {
    return { cacheable: false };
  }
  return {
    cacheable: true,
    cacheControl,
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
  const varyRejectionReason = cacheabilityVaryRejectionReason(response.headers, state);
  if (varyRejectionReason) return { cacheable: false, reason: varyRejectionReason };
  if (state.route?.kind === "app-route") {
    if (response.headers.has("set-cookie")) {
      return { cacheable: false, reason: "response sets a cookie" };
    }
    return inferPagesPageCacheability(response, state);
  }
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
  const responseOutcome = inferPagesPageCacheability(response, state);
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

  for (const name of state.responsePolicyHeaderNames ?? CACHEABILITY_POLICY_HEADERS) {
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

  // App Route Handlers normally prove body completion inside their execution
  // boundary, while Pages APIs arrive here with their stream still live.
  // Config or application headers can explicitly publish either response.
  // Require a clean completed body before an unlisted endpoint can enter the
  // shared cache.
  if (state.route?.kind === "app-route" || state.route?.kind === "pages-api") {
    let manifestRoute: CacheabilityManifestRoute | null = null;
    const responseOutcome = inferPagesPageCacheability(response, state);
    const representation = admission?.representation
      ? resolveCacheabilityRepresentation(
          admission.representation as CacheabilityRepresentation,
          state.route.kind,
        )
      : null;
    const hasExplicitRuntimePolicy =
      state.explicitResponseCachePolicy === true ||
      state.explicitConfigCachePolicy === true ||
      (state.route.kind === "pages-api" && responseOutcome.cacheable);
    if (!admission || admission.policy === "deny" || !representation || !admission.requestKey) {
      return responseWithCachePolicy(response, response.body, null);
    }
    if (admission.policy === "manifest" && state.route.kind === "app-route") {
      const manifest = admission.manifest as CacheabilityManifest;
      manifestRoute = findCacheabilityManifestRoute(
        manifest,
        state.route.kind,
        state.route.pattern,
      );
    }
    const isManifestAuthorized =
      manifestRoute !== null &&
      admission.routePathname !== undefined &&
      cacheabilityManifestRouteState(manifestRoute, admission.routePathname, representation) !==
        null;
    const canUseBoundedRuntimeAdmission =
      hasExplicitRuntimePolicy &&
      (admission.policy === "runtime" ||
        (admission.policy === "manifest" && !isManifestAuthorized));
    if (
      (!isManifestAuthorized && !canUseBoundedRuntimeAdmission) ||
      response.status >= 500 ||
      state.forcedDynamicReason ||
      hasStrictFinalResponseVeto(response, state) ||
      cacheabilityVaryRejectionReason(response.headers, state) !== null
    ) {
      return responseWithCachePolicy(response, response.body, null);
    }

    const outcome = responseOutcome;
    if (!outcome.cacheable || !outcome.cacheControl) {
      return responseWithCachePolicy(response, response.body, null);
    }
    if (state.completedResponseBody) {
      if (!state.applyCompletedResponsePolicy) return response;
      return responseWithCachePolicy(response, response.body, outcome);
    }

    let captured: CapturedAdmissionBody;
    try {
      captured = await captureCacheabilityAdmissionBody(
        response.body,
        state.captureDeadlineAt,
        CACHEABILITY_ADMISSION_RESPONSE_BODY_LIMIT,
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
  const representation = resolveCacheabilityRepresentation(
    admission.representation as CacheabilityRepresentation,
    state.route.kind,
  );
  const representationMatchesRoute =
    state.route.kind === "app-page"
      ? representation === "html" ||
        representation === "rsc-full" ||
        representation === "rsc-loading-shell"
      : representation === "html" || representation === "pages-data";
  if (!representationMatchesRoute) {
    return responseWithCachePolicy(response, response.body, null);
  }

  let manifestRoute: CacheabilityManifestRoute | null = null;
  let manifestRouteState: ReturnType<typeof cacheabilityManifestRouteState> = null;
  if (admission.policy === "manifest") {
    const manifest = admission.manifest as CacheabilityManifest;
    manifestRoute = findCacheabilityManifestRoute(manifest, state.route.kind, state.route.pattern);
    manifestRouteState =
      manifestRoute && admission.routePathname
        ? cacheabilityManifestRouteState(manifestRoute, admission.routePathname, representation)
        : null;
    if (!manifestRoute || !manifestRouteState) {
      return responseWithCachePolicy(response, response.body, null);
    }
  }

  if (state.forcedDynamicReason) {
    return responseWithCachePolicy(response, response.body, null);
  }
  if (hasStrictFinalResponseVeto(response, state)) {
    return responseWithCachePolicy(response, response.body, null);
  }
  if (cacheabilityVaryRejectionReason(response.headers, state) !== null) {
    return responseWithCachePolicy(response, response.body, null);
  }
  let captured: CapturedAdmissionBody;
  try {
    captured = await captureCacheabilityAdmissionBody(
      response.body,
      state.captureDeadlineAt,
      CACHEABILITY_ADMISSION_RESPONSE_BODY_LIMIT,
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
    if (
      manifestRoute &&
      manifestRouteState === "static-candidate" &&
      outcome?.dynamicUsage === true
    ) {
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

  if (state.patternDynamicReason && !state.explicitConfigCachePolicy) {
    // Route configuration is pattern-wide, but Next.js lets a matching
    // next.config public cache policy override force-dynamic/revalidate=0.
    // Config headers are applied before this Worker finalizer, so only bypass
    // the render body when no explicit policy still needs completed-response
    // classification. A real route 5xx above must never be hidden by pruning.
    await response.body?.cancel().catch(() => {});
    return probeResponse(
      state,
      "dynamic",
      { cacheable: false, reason: state.patternDynamicReason },
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
    rendererOutcome?.cacheable === true && rendererOutcome.dynamicUsage !== true,
  );
}
