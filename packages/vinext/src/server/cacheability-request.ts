import type { ExecutionContextLike } from "vinext/shims/request-context";
import { getRequestExecutionContext } from "vinext/shims/request-context";
import { getCdnCacheAdapter, isNonCacheableCacheControl } from "vinext/shims/cdn-cache";
import { applyCdnResponseHeaders, NO_STORE_CACHE_CONTROL } from "./cache-control.js";
import {
  cacheabilityRouteKey,
  cacheabilityRouteAllowsPath,
  getEmbeddedCacheabilityManifest,
  type CacheabilityManifestRoute,
  type CacheabilityRouteKind,
  type CacheabilityRouteState,
} from "./cacheability-manifest.js";
import {
  RSC_HEADER,
  VINEXT_RSC_VARY_HEADER,
  VINEXT_CACHEABILITY_PROBE_HEADER,
  VINEXT_PRERENDER_SECRET_HEADER,
} from "./headers.js";
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
  capturedBody?: ArrayBuffer | null;
  releaseCapturedBody?: () => void;
  complete?: (outcome: CacheabilityOutcome) => void;
  completion?: Promise<CacheabilityOutcome>;
  manifestRoute?: CacheabilityManifestRoute;
  mode: "admit" | "admit-all" | "probe";
  outcome?: CacheabilityOutcome;
  provisionalPolicy?: CacheabilityPolicySnapshot;
  requestHeaders: Record<string, string>;
  requestIsRsc: boolean;
  requestMethod: string;
  requestPathname: string;
  route?: CacheabilityRequestRoute;
  unsafeReason?: string;
};

type CacheabilityPolicySnapshot = {
  cacheControl: string | null;
  cdnCacheControl: string | null;
  cloudflareCdnCacheControl: string | null;
};

const CACHEABILITY_STATE = Symbol.for("vinext.cacheabilityRequestState");
// Runtime-check responses are temporarily represented by the source stream,
// an unread tee branch, and the final contiguous buffer. Keep the per-request
// ceiling low enough to leave useful headroom in a Worker isolate.
export const CACHEABILITY_RESPONSE_BODY_LIMIT = 4 * 1024 * 1024;
// Capturing keeps a tee branch, chunk views, and a contiguous artifact alive
// at once. Bound aggregate in-flight work per isolate as well as each request;
// excess requests keep streaming but fail CDN admission closed.
export const CACHEABILITY_RESPONSE_CAPTURE_BUDGET = 4 * CACHEABILITY_RESPONSE_BODY_LIMIT;
// Leave headroom below the deploy probe's 30s request timeout so a slow or
// never-ending response can still return its fail-closed probe envelope.
export const CACHEABILITY_RESPONSE_CAPTURE_TIMEOUT_MS = 20_000;

let reservedCaptureBytes = 0;

export function reserveCacheabilityResponseCapture(): (() => void) | null {
  // The aggregate ceiling protects the 128 MiB Worker isolate. Node/Nitro
  // processes and programmatic Full Route Cache writes retain the per-response
  // bound, but do not participate in CDN probe/admission capture.
  const context = getRequestExecutionContext();
  if (
    context?.hostRuntime !== "worker" ||
    context.isCloudflareWorker !== true ||
    context.trustedRevalidateOrigin !== undefined ||
    !readState(context)
  ) {
    return () => {};
  }
  if (
    reservedCaptureBytes + CACHEABILITY_RESPONSE_BODY_LIMIT >
    CACHEABILITY_RESPONSE_CAPTURE_BUDGET
  ) {
    return null;
  }
  reservedCaptureBytes += CACHEABILITY_RESPONSE_BODY_LIMIT;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    reservedCaptureBytes -= CACHEABILITY_RESPONSE_BODY_LIMIT;
  };
}

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
const SUPPORTED_VARY_HEADERS = new Set(
  VINEXT_RSC_VARY_HEADER.split(",").map((name) => name.trim().toLowerCase()),
);

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

export function isAdmissibleCacheStatus(status: number): boolean {
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
  if (!isAdmissibleCacheStatus(response.status) || response.headers.has("set-cookie")) return true;
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
  if (!isAdmissibleCacheStatus(response.status) || response.headers.has("set-cookie")) return false;
  if (hasNonCacheablePolicy(response.headers)) return false;
  const policy =
    response.headers.get("CDN-Cache-Control") ??
    response.headers.get("Cloudflare-CDN-Cache-Control") ??
    response.headers.get("Cache-Control");
  if (!policy) return false;
  return policy
    .split(",")
    .map((directive) => directive.trim().match(/^(?:s-maxage|max-age)\s*=\s*"?(\d+)"?$/i))
    .some((match) => match !== null && Number(match[1]) > 0);
}

function responseHasUnsupportedVary(response: Response): boolean {
  return (response.headers.get("Vary") ?? "")
    .split(",")
    .some((name) => name.trim() !== "" && !SUPPORTED_VARY_HEADERS.has(name.trim().toLowerCase()));
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

function createStaticToDynamicError(
  state: CacheabilityRequestState,
  outcome: CacheabilityOutcome,
): Error {
  const reason = outcome.reason ? `, reason: ${outcome.reason}` : "";
  return new Error(
    `Page changed from static to dynamic at runtime ${state.requestPathname}${reason}` +
      "\nsee more here https://nextjs.org/docs/messages/app-static-to-dynamic-error",
  );
}

async function reportStaticToDynamicError(
  state: CacheabilityRequestState,
  outcome: CacheabilityOutcome,
): Promise<void> {
  const error = createStaticToDynamicError(state, outcome);
  console.error(error);
  if (!globalThis.__VINEXT_onRequestErrorHandler__) return;

  // Static-to-dynamic is exceptional and rare. Keep instrumentation runtime
  // code out of the common cache-admission chunk, but report through the same
  // hook and request metadata as other Next.js-compatible request failures.
  const { reportRequestError } = await import("./instrumentation.js");
  void reportRequestError(
    error,
    {
      headers: state.requestHeaders,
      method: state.requestMethod,
      path: state.requestPathname,
    },
    {
      routerKind: state.route?.kind === "pages-page" ? "Pages Router" : "App Router",
      routePath: state.route?.pattern ?? state.requestPathname,
      routeType: state.route?.kind === "app-route" ? "route" : "render",
    },
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

export type CapturedResponseBody =
  | {
      body: ArrayBuffer | null;
      fallback: ReadableStream<Uint8Array> | null;
      failClosed: false;
      release: () => void;
    }
  | { fallback: ReadableStream<Uint8Array>; failClosed: true; reason: string };

/**
 * Collect a response body only while it remains within the Worker-safe size
 * and time bounds. The fallback branch preserves every byte when collection
 * must stop, allowing callers to fail cache admission without breaking the
 * streamed response.
 */
export async function captureResponseBodyBounded(
  response: Response,
): Promise<CapturedResponseBody> {
  if (!response.body) {
    return { body: null, fallback: null, failClosed: false, release: () => {} };
  }

  const declaredLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > CACHEABILITY_RESPONSE_BODY_LIMIT) {
    return {
      failClosed: true,
      fallback: response.body,
      reason: `response body exceeded ${CACHEABILITY_RESPONSE_BODY_LIMIT} bytes`,
    };
  }

  const releaseCapture = reserveCacheabilityResponseCapture();
  if (!releaseCapture) {
    return {
      failClosed: true,
      fallback: response.body,
      reason: `response capture exceeded the ${CACHEABILITY_RESPONSE_CAPTURE_BUDGET} byte isolate budget`,
    };
  }

  let captureStream: ReadableStream<Uint8Array>;
  let fallback: ReadableStream<Uint8Array>;
  try {
    [captureStream, fallback] = response.body.tee();
  } catch (error) {
    releaseCapture();
    throw error;
  }
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
      releaseCapture();
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
    releaseCapture();
    throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }

  try {
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { body: body.buffer, fallback, failClosed: false, release: releaseCapture };
  } catch (error) {
    releaseCapture();
    void fallback.cancel().catch(() => {});
    throw error;
  }
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
  if (
    !authorizedProbe &&
    (base.hostRuntime !== "worker" || getCdnCacheAdapter().ownsBackgroundRevalidation)
  ) {
    return base;
  }

  const state: CacheabilityRequestState = {
    mode: authorizedProbe ? "probe" : manifest ? "admit" : "admit-all",
    requestHeaders: Object.fromEntries(request.headers),
    requestIsRsc: request.headers.get(RSC_HEADER) === "1",
    requestMethod: request.method,
    requestPathname: new URL(request.url).pathname,
  };
  return Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
    [CACHEABILITY_STATE]: state,
  });
}

export function beginRouteCacheability(
  kind: CacheabilityRouteKind,
  pattern: string,
  options: { partialPrerender?: boolean; useManifestClassification?: boolean } = {},
): boolean {
  const state = readState(getRequestExecutionContext());
  if (!state) return false;

  // Authenticated probes must observe the route regardless of the configured
  // serving strategy. Ordinary requests only need late edge admission when a
  // CDN owns revalidation; the default KV/data-cache strategy already captures
  // the completed artifact programmatically and must retain streaming parity.
  if (state.mode !== "probe" && getCdnCacheAdapter().ownsBackgroundRevalidation) return false;

  const manifestRoutes =
    options.useManifestClassification === false || (kind === "app-page" && state.requestIsRsc)
      ? undefined
      : getEmbeddedCacheabilityManifest()?.routes;
  // The staged probe certifies the HTML document representation. Full RSC
  // and loading-shell responses can execute a different part of a PPR tree,
  // so they retain their own completed-response runtime check.
  const exactManifestRoute =
    manifestRoutes?.[cacheabilityRouteKey(kind, pattern, state.requestPathname)];
  const patternManifestRoute = manifestRoutes?.[cacheabilityRouteKey(kind, pattern)];
  const manifestRoute =
    exactManifestRoute ??
    (patternManifestRoute &&
    !cacheabilityRouteAllowsPath(patternManifestRoute, state.requestPathname)
      ? { ...patternManifestRoute, state: "dynamic" as const }
      : patternManifestRoute);
  state.route = { kind, pattern, partialPrerender: options.partialPrerender === true };
  state.manifestRoute = manifestRoute;

  if (state.unsafeReason) {
    state.outcome = { cacheable: false, reason: state.unsafeReason };
    return true;
  }
  if (
    state.mode === "admit" &&
    (manifestRoute?.state === "dynamic" || manifestRoute?.state === "probe-failed")
  ) {
    state.unsafeReason =
      manifestRoute.state === "dynamic"
        ? "staged probe classified this route as dynamic"
        : "staged probe could not certify this route";
    state.outcome = { cacheable: false, reason: state.unsafeReason };
    return false;
  }

  return true;
}

/** True only for an authenticated staged-Worker cacheability probe. */
export function isRouteCacheabilityProbe(): boolean {
  return readState(getRequestExecutionContext())?.mode === "probe";
}

/** A final manifest has already proven this concrete route representation dynamic. */
export function isRouteManifestProvenDynamic(): boolean {
  const state = readState(getRequestExecutionContext());
  return (
    state?.mode === "admit" &&
    (state.manifestRoute?.state === "dynamic" || state.manifestRoute?.state === "probe-failed")
  );
}

/** Prevent whole-response CDN admission when an earlier request phase can vary this URL. */
export function markRequestCacheabilityUnsafe(reason: string): void {
  const state = readState(getRequestExecutionContext());
  if (!state || state.unsafeReason) return;
  state.unsafeReason = reason;
  if (state.route) {
    recordRouteCacheability({ cacheable: false, reason });
  }
}

export function deferRouteCacheability(): ((outcome: CacheabilityOutcome) => void) | null {
  const state = readState(getRequestExecutionContext());
  if (!state?.route || state.completion) return null;

  state.completion = new Promise<CacheabilityOutcome>((resolve) => {
    state.complete = (outcome) => {
      const finalOutcome = state.unsafeReason
        ? { cacheable: false, reason: state.unsafeReason }
        : outcome;
      state.outcome = finalOutcome;
      resolve(finalOutcome);
    };
  });
  return (outcome) => state.complete?.(outcome);
}

export function recordRouteCacheability(outcome: CacheabilityOutcome): void {
  const state = readState(getRequestExecutionContext());
  if (!state?.route) return;
  const finalOutcome = state.unsafeReason
    ? { cacheable: false, reason: state.unsafeReason }
    : outcome;
  state.outcome = finalOutcome;
  state.complete?.(finalOutcome);
}

/** Reuse a body already collected by the route's Full Route Cache owner. */
export function recordRouteCacheabilityCapturedBody(
  body: ArrayBuffer | null,
  release?: () => void,
): boolean {
  const state = readState(getRequestExecutionContext());
  if (!state?.route) return false;
  state.releaseCapturedBody?.();
  state.capturedBody = body;
  state.releaseCapturedBody = release;
  return true;
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
  try {
    return await finalizeWorkerCacheabilityResponseWithState(response, state);
  } finally {
    state.releaseCapturedBody?.();
    state.releaseCapturedBody = undefined;
  }
}

async function finalizeWorkerCacheabilityResponseWithState(
  response: Response,
  state: CacheabilityRequestState,
): Promise<Response> {
  if (!state.route) {
    if (state.mode === "probe") {
      return probeResponse(
        state,
        "probe-failed",
        { cacheable: false, reason: "request did not resolve to a probeable route" },
        response.status,
      );
    }
    return state.unsafeReason && !isUpgradeResponse(response)
      ? uncacheableStreamingResponse(response)
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
  const staticToDynamicErrorResponse = async (outcome: CacheabilityOutcome): Promise<Response> => {
    await reportStaticToDynamicError(state, outcome);
    return syntheticErrorResponse(response);
  };

  const explicitOutcome = state.outcome;
  if (staticCandidateBecameDynamic(explicitOutcome)) {
    void response.body?.cancel().catch(() => {});
    return staticToDynamicErrorResponse(explicitOutcome!);
  }

  const isEventStream = response.headers
    .get("content-type")
    ?.toLowerCase()
    .startsWith("text/event-stream");
  const unsupportedVary = responseHasUnsupportedVary(response);
  if (
    isEventStream ||
    unsupportedVary ||
    explicitOutcome?.cacheable === false ||
    responseHasFinalCacheOptOut(response, state) ||
    (!state.completion && !responsePolicyIsCacheable(response))
  ) {
    if (state.mode === "probe") {
      void response.body?.cancel().catch(() => {});
      return probeResponse(
        state,
        "dynamic",
        explicitOutcome ?? {
          cacheable: false,
          reason: isEventStream
            ? "event stream"
            : unsupportedVary
              ? "response varies by an unsupported request header"
              : undefined,
        },
        response.status,
      );
    }
    return uncacheableStreamingResponse(response);
  }

  const deferredOutcome = state.completion ? await state.completion : undefined;
  let captured: CapturedResponseBody;
  if (state.capturedBody !== undefined) {
    captured = { body: state.capturedBody, fallback: null, failClosed: false, release: () => {} };
  } else {
    try {
      captured = await captureResponseBodyBounded(response);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (state.mode === "probe") {
        return probeResponse(state, "probe-failed", { cacheable: false, reason }, response.status);
      }
      return syntheticErrorResponse(response);
    }
  }

  const releaseCaptured = captured.failClosed ? null : captured.release;
  try {
    if (captured.failClosed) {
      if (
        state.mode !== "probe" &&
        state.manifestRoute?.state === "static-candidate" &&
        state.route.partialPrerender !== true
      ) {
        void captured.fallback.cancel().catch(() => {});
        return staticToDynamicErrorResponse({
          cacheable: false,
          dynamicUsage: true,
          reason: captured.reason,
        });
      }
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

    const outcome =
      deferredOutcome ??
      state.outcome ??
      ({
        cacheable: responsePolicyIsCacheable(response),
        cacheControl:
          response.headers.get("CDN-Cache-Control") ??
          response.headers.get("Cloudflare-CDN-Cache-Control") ??
          response.headers.get("Cache-Control") ??
          undefined,
      } satisfies CacheabilityOutcome);
    const cacheable =
      !state.unsafeReason && outcome.cacheable && !responseHasFinalCacheOptOut(response, state);

    if (state.mode === "probe") {
      await captured.fallback?.cancel().catch(() => {});
      return probeResponse(
        state,
        cacheable ? "static-candidate" : "dynamic",
        outcome,
        response.status,
      );
    }

    if (staticCandidateBecameDynamic(outcome)) {
      await captured.fallback?.cancel().catch(() => {});
      return staticToDynamicErrorResponse(outcome);
    }

    await captured.fallback?.cancel().catch(() => {});

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
  } finally {
    releaseCaptured?.();
  }
}
