import type { ExecutionContextLike } from "vinext/shims/request-context";
import { getRequestExecutionContext } from "vinext/shims/request-context";
import { getCdnCacheAdapter, isNonCacheableCacheControl } from "vinext/shims/cdn-cache";
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
  dynamicUsage?: boolean;
  reason?: string;
  tags?: readonly string[];
};

type CacheabilityRequestRoute = Pick<CacheabilityManifestRoute, "kind" | "pattern"> & {
  partialPrerender: boolean;
};

type CacheabilityRequestState = {
  complete?: (outcome: CacheabilityOutcome) => void;
  completion?: Promise<CacheabilityOutcome>;
  manifestRoute?: CacheabilityManifestRoute;
  mode: "admit" | "admit-all" | "probe";
  outcome?: CacheabilityOutcome;
  provisionalPolicy?: CacheabilityPolicySnapshot;
  route?: CacheabilityRequestRoute;
};

type CacheabilityPolicySnapshot = {
  cacheControl: string | null;
  cdnCacheControl: string | null;
  cloudflareCdnCacheControl: string | null;
};

const CACHEABILITY_STATE = Symbol.for("vinext.cacheabilityRequestState");
export const CACHEABILITY_RESPONSE_BODY_LIMIT = 16 * 1024 * 1024;
export const CACHEABILITY_RESPONSE_CAPTURE_TIMEOUT_MS = 30_000;

const REPRESENTATION_HEADERS = [
  "accept-ranges",
  "content-digest",
  "content-disposition",
  "content-encoding",
  "content-language",
  "content-length",
  "content-range",
  "content-type",
  "digest",
  "etag",
  "last-modified",
  "repr-digest",
  "trailer",
  "transfer-encoding",
] as const;

function readState(ctx: ExecutionContextLike | null | undefined): CacheabilityRequestState | null {
  if (!ctx) return null;
  return (Reflect.get(ctx, CACHEABILITY_STATE) as CacheabilityRequestState | undefined) ?? null;
}

function snapshotCachePolicy(headers: Headers): CacheabilityPolicySnapshot {
  return {
    cacheControl: headers.get("Cache-Control"),
    cdnCacheControl: headers.get("CDN-Cache-Control"),
    cloudflareCdnCacheControl: headers.get("Cloudflare-CDN-Cache-Control"),
  };
}

function cachePoliciesMatch(a: CacheabilityPolicySnapshot, b: CacheabilityPolicySnapshot): boolean {
  return (
    a.cacheControl === b.cacheControl &&
    a.cdnCacheControl === b.cdnCacheControl &&
    a.cloudflareCdnCacheControl === b.cloudflareCdnCacheControl
  );
}

function isAdmissibleStatus(status: number): boolean {
  return (status >= 200 && status < 400) || status === 404;
}

function hasNonCacheablePolicy(headers: Headers): boolean {
  return [
    headers.get("Cache-Control"),
    headers.get("CDN-Cache-Control"),
    headers.get("Cloudflare-CDN-Cache-Control"),
  ].some((policy) => policy !== null && isNonCacheableCacheControl(policy));
}

function responseHasFinalCacheOptOut(response: Response, state: CacheabilityRequestState): boolean {
  if (!isAdmissibleStatus(response.status) || response.headers.has("set-cookie")) return true;
  if (!hasNonCacheablePolicy(response.headers)) return false;

  // App-page candidates deliberately carry an adapter-generated private policy
  // while the lazy render is still unproven. Only that exact request-scoped
  // snapshot may be replaced after completion. A later config/user/middleware
  // policy invalidates or differs from the snapshot and therefore wins.
  return !(
    state.provisionalPolicy &&
    cachePoliciesMatch(state.provisionalPolicy, snapshotCachePolicy(response.headers))
  );
}

function responsePolicyIsCacheable(response: Response): boolean {
  if (!isAdmissibleStatus(response.status) || response.headers.has("set-cookie")) return false;
  if (hasNonCacheablePolicy(response.headers)) return false;
  return Boolean(
    response.headers.get("CDN-Cache-Control") ??
    response.headers.get("Cloudflare-CDN-Cache-Control") ??
    response.headers.get("Cache-Control"),
  );
}

function isUpgradeResponse(response: Response): boolean {
  return (
    response.status === 101 ||
    response.headers.has("Upgrade") ||
    Reflect.get(response, "webSocket") != null
  );
}

function syntheticErrorResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const name of REPRESENTATION_HEADERS) headers.delete(name);
  applyCdnResponseHeaders(headers, { cacheControl: NO_STORE_CACHE_CONTROL });
  return new Response("Internal Server Error", { headers, status: 500 });
}

function reportStaticToDynamicError(
  state: CacheabilityRequestState,
  outcome: CacheabilityOutcome,
): void {
  const reason = outcome.reason ? `, reason: ${outcome.reason}` : "";
  console.error(
    `Page changed from static to dynamic at runtime ${state.route?.pattern ?? "unknown"}${reason}` +
      "\nsee more here https://nextjs.org/docs/messages/app-static-to-dynamic-error",
  );
}

function uncacheableStreamingResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  applyCdnResponseHeaders(headers, { cacheControl: NO_STORE_CACHE_CONTROL });
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

type CapturedBody =
  | { body: ArrayBuffer | null; fallback: ReadableStream<Uint8Array> | null; failClosed: false }
  | { fallback: ReadableStream<Uint8Array>; failClosed: true; reason: string };

async function captureResponseBody(response: Response): Promise<CapturedBody> {
  if (!response.body) return { body: null, fallback: null, failClosed: false };

  const declaredLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > CACHEABILITY_RESPONSE_BODY_LIMIT) {
    return {
      failClosed: true,
      fallback: response.body,
      reason: `response body exceeded ${CACHEABILITY_RESPONSE_BODY_LIMIT} bytes`,
    };
  }

  const [captureStream, fallback] = response.body.tee();
  const reader = captureStream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    const readResult = await Promise.race([
      (async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) return "complete" as const;
          length += value.byteLength;
          if (length > CACHEABILITY_RESPONSE_BODY_LIMIT) return "oversized" as const;
          chunks.push(value);
        }
      })(),
      new Promise<"timed-out">((resolve) => {
        timeout = setTimeout(() => resolve("timed-out"), CACHEABILITY_RESPONSE_CAPTURE_TIMEOUT_MS);
      }),
    ]);
    if (readResult !== "complete") {
      void reader.cancel().catch(() => {});
      return {
        failClosed: true,
        fallback,
        reason:
          readResult === "timed-out"
            ? `response body did not complete within ${CACHEABILITY_RESPONSE_CAPTURE_TIMEOUT_MS}ms`
            : `response body exceeded ${CACHEABILITY_RESPONSE_BODY_LIMIT} bytes`,
      };
    }
  } catch (error) {
    void fallback.cancel().catch(() => {});
    throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }

  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body: body.buffer, fallback, failClosed: false };
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

export function beginRouteCacheability(
  kind: CacheabilityRouteKind,
  pattern: string,
  options: { partialPrerender?: boolean } = {},
): boolean {
  const state = readState(getRequestExecutionContext());
  if (!state) return false;

  // Authenticated probes must observe the route regardless of the configured
  // serving strategy. Ordinary requests only need late edge admission when a
  // CDN owns revalidation; the default KV/data-cache strategy already captures
  // the completed artifact programmatically and must retain streaming parity.
  if (state.mode !== "probe" && getCdnCacheAdapter().ownsBackgroundRevalidation) return false;

  const manifestRoute =
    getEmbeddedCacheabilityManifest()?.routes[cacheabilityRouteKey(kind, pattern)];
  if (
    state.mode === "admit" &&
    (manifestRoute?.state === "dynamic" || manifestRoute?.state === "probe-failed")
  ) {
    return false;
  }

  state.route = { kind, pattern, partialPrerender: options.partialPrerender === true };
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

/** Record the exact adapter policy used only while an App render is unproven. */
export function markRouteCacheabilityPolicyProvisional(headers: Headers): void {
  const state = readState(getRequestExecutionContext());
  if (!state?.route || !state.completion) return;
  state.provisionalPolicy = snapshotCachePolicy(headers);
}

/** Ensure a later explicit config policy cannot be mistaken for the provisional policy. */
export function invalidateRouteCacheabilityProvisionalPolicy(): void {
  const state = readState(getRequestExecutionContext());
  if (!state?.route) return;
  state.provisionalPolicy = undefined;
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

  // Upgrade/WebSocket responses carry runtime-owned state outside the standard
  // body/header tuple. Reconstructing them drops that state, so never admit or
  // reshape an ordinary upgrade response.
  if (isUpgradeResponse(response)) {
    if (state.mode !== "probe") return response;
    return probeResponse(
      state,
      "dynamic",
      { cacheable: false, reason: "upgrade response" },
      response.status,
    );
  }

  if (state.mode === "probe" && response.status >= 500) {
    void response.body?.cancel().catch(() => {});
    return probeResponse(
      state,
      "probe-failed",
      { cacheable: false, reason: `route returned HTTP ${response.status}` },
      response.status,
    );
  }

  const staticCandidateBecameDynamic = (outcome: CacheabilityOutcome | undefined): boolean =>
    state.mode !== "probe" &&
    state.manifestRoute?.state === "static-candidate" &&
    state.route?.partialPrerender !== true &&
    outcome?.dynamicUsage === true;
  const staticToDynamicError = (outcome: CacheabilityOutcome): Response => {
    reportStaticToDynamicError(state, outcome);
    return syntheticErrorResponse(response);
  };

  const explicitOutcome = state.outcome;
  if (staticCandidateBecameDynamic(explicitOutcome)) {
    void response.body?.cancel().catch(() => {});
    return staticToDynamicError(explicitOutcome!);
  }

  const isEventStream = response.headers
    .get("content-type")
    ?.toLowerCase()
    .startsWith("text/event-stream");
  if (
    isEventStream ||
    explicitOutcome?.cacheable === false ||
    responseHasFinalCacheOptOut(response, state) ||
    (!state.completion && !responsePolicyIsCacheable(response))
  ) {
    if (state.mode === "probe") {
      void response.body?.cancel().catch(() => {});
      return probeResponse(
        state,
        "dynamic",
        explicitOutcome ?? { cacheable: false, reason: isEventStream ? "event stream" : undefined },
        response.status,
      );
    }
    return uncacheableStreamingResponse(response);
  }

  let captured: CapturedBody;
  try {
    captured = await captureResponseBody(response);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (state.mode === "probe") {
      return probeResponse(state, "probe-failed", { cacheable: false, reason }, response.status);
    }
    return syntheticErrorResponse(response);
  }

  if (captured.failClosed) {
    if (state.mode === "probe") {
      void captured.fallback.cancel().catch(() => {});
      return probeResponse(
        state,
        "dynamic",
        {
          cacheable: false,
          reason: captured.reason,
        },
        response.status,
      );
    }
    return uncacheableStreamingResponse(
      new Response(captured.fallback, {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
      }),
    );
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
  const cacheable = outcome.cacheable && !responseHasFinalCacheOptOut(response, state);

  if (state.mode === "probe") {
    void captured.fallback?.cancel().catch(() => {});
    return probeResponse(
      state,
      cacheable ? "static-candidate" : "dynamic",
      outcome,
      response.status,
    );
  }

  if (staticCandidateBecameDynamic(outcome)) {
    void captured.fallback?.cancel().catch(() => {});
    return staticToDynamicError(outcome);
  }

  void captured.fallback?.cancel().catch(() => {});

  const headers = new Headers(response.headers);
  if (cacheable && outcome.cacheControl) {
    applyCdnResponseHeaders(headers, {
      cacheControl: outcome.cacheControl,
      tags: outcome.tags,
    });
  } else {
    applyCdnResponseHeaders(headers, { cacheControl: NO_STORE_CACHE_CONTROL });
  }
  return new Response(captured.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}
