import type { ExecutionContextLike } from "vinext/shims/request-context";
import { getRequestExecutionContext } from "vinext/shims/request-context";
import { getCdnCacheAdapter, isNonCacheableCacheControl } from "vinext/shims/cdn-cache";
import { applyCdnResponseHeaders, NO_STORE_CACHE_CONTROL } from "./cache-control.js";
import {
  cacheabilityManifestHasGeneratedPath,
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
import { deferUntilStreamConsumed } from "./defer-until-stream-consumed.js";
import { CACHEABILITY_REQUEST_STATE } from "vinext/shims/cacheability-classification";

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
  closed?: boolean;
  releaseCapturedBodies?: Set<() => void>;
  complete?: (outcome: CacheabilityOutcome) => void;
  completion?: Promise<CacheabilityOutcome>;
  manifestRoute?: CacheabilityManifestRoute;
  mode: "admit" | "admit-all" | "identity" | "probe";
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

export type CacheabilityCaptureReservation = {
  forceReserve(this: void, bytes: number): void;
  release(this: void, bytes: number): void;
  releaseAll(this: void): void;
  tryReserve(this: void, bytes: number): boolean;
};

export function createCacheabilityCaptureReservation(): CacheabilityCaptureReservation {
  const context = getRequestExecutionContext();
  const tracksWorkerMemory =
    context?.hostRuntime === "worker" &&
    context.isCloudflareWorker === true &&
    context.trustedRevalidateOrigin === undefined &&
    readState(context) !== null;
  let ownedBytes = 0;
  return {
    forceReserve(bytes) {
      if (!tracksWorkerMemory || bytes <= 0) return;
      reservedCaptureBytes += bytes;
      ownedBytes += bytes;
    },
    release(bytes) {
      if (!tracksWorkerMemory || bytes <= 0) return;
      const released = Math.min(bytes, ownedBytes);
      ownedBytes -= released;
      reservedCaptureBytes -= released;
    },
    releaseAll() {
      if (!tracksWorkerMemory || ownedBytes === 0) return;
      reservedCaptureBytes -= ownedBytes;
      ownedBytes = 0;
    },
    tryReserve(bytes) {
      if (bytes <= 0 || !tracksWorkerMemory) return true;
      if (reservedCaptureBytes + bytes > CACHEABILITY_RESPONSE_CAPTURE_BUDGET) return false;
      reservedCaptureBytes += bytes;
      ownedBytes += bytes;
      return true;
    },
  };
}

function streamCapturedPrefixThenReader(
  prefix: Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>,
  releasePrefix: () => void,
): ReadableStream<Uint8Array> {
  let index = 0;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    releasePrefix();
  };
  return new ReadableStream<Uint8Array>(
    {
      async cancel(reason) {
        prefix.length = 0;
        release();
        await reader.cancel(reason).catch(() => {});
      },
      async pull(controller) {
        try {
          if (index < prefix.length) {
            controller.enqueue(prefix[index++]);
            if (index === prefix.length) {
              prefix.length = 0;
              release();
            }
            return;
          }
          release();
          const result = await reader.read();
          if (result.done) controller.close();
          else controller.enqueue(result.value);
        } catch (error) {
          release();
          controller.error(error);
        }
      },
    },
    { highWaterMark: 0 },
  );
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
  return (
    (Reflect.get(ctx, CACHEABILITY_REQUEST_STATE) as CacheabilityRequestState | undefined) ?? null
  );
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
  options: { signal?: AbortSignal } = {},
): Promise<CapturedResponseBody> {
  if (options.signal?.aborted) {
    throw options.signal.reason ?? new Error("response capture was aborted");
  }
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

  const reservation = createCacheabilityCaptureReservation();

  let captureStream: ReadableStream<Uint8Array>;
  let fallback: ReadableStream<Uint8Array>;
  try {
    [captureStream, fallback] = response.body.tee();
  } catch (error) {
    reservation.releaseAll();
    throw error;
  }
  const reader = captureStream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let retainedChunkBytes = 0;
  let overflowChunk: Uint8Array | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;

  try {
    const readResult = await Promise.race([
      (async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) return "complete" as const;
          length += value.byteLength;
          if (length > CACHEABILITY_RESPONSE_BODY_LIMIT) {
            overflowChunk = value;
            return "oversized" as const;
          }
          // The capture and unread fallback tee branches both retain this
          // chunk until classification completes.
          if (!reservation.tryReserve(value.byteLength * 2)) {
            overflowChunk = value;
            return "budget-exhausted" as const;
          }
          retainedChunkBytes += value.byteLength;
          chunks.push(value);
        }
      })(),
      new Promise<"timed-out">((resolve) => {
        timeout = setTimeout(() => resolve("timed-out"), CACHEABILITY_RESPONSE_CAPTURE_TIMEOUT_MS);
      }),
      new Promise<"aborted">((resolve) => {
        const signal = options.signal;
        if (!signal) return;
        const onAbort = () => resolve("aborted");
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      }),
    ]);
    if (readResult === "aborted") {
      await Promise.allSettled([reader.cancel(options.signal?.reason), fallback.cancel()]);
      reservation.releaseAll();
      throw options.signal?.reason ?? new Error("response capture was aborted");
    }
    if (readResult !== "complete") {
      if (readResult !== "timed-out") {
        // The current chunk has already left the source, so returning the tee
        // fallback would retain an uncharged duplicate. Drop that branch and
        // stream the captured prefix plus the original reader instead.
        void fallback.cancel().catch(() => {});
        reservation.release(retainedChunkBytes);
        if (overflowChunk) {
          reservation.forceReserve(overflowChunk.byteLength);
          chunks.push(overflowChunk);
        }
        return {
          failClosed: true,
          fallback: streamCapturedPrefixThenReader(chunks, reader, reservation.releaseAll),
          reason:
            readResult === "budget-exhausted"
              ? `response capture exceeded the ${CACHEABILITY_RESPONSE_CAPTURE_BUDGET} byte isolate budget`
              : `response body exceeded ${CACHEABILITY_RESPONSE_BODY_LIMIT} bytes`,
        };
      }
      void reader.cancel().catch(() => {});
      // Cancelling the capture branch drops one of the two retained copies;
      // the fallback keeps the other until its consumer drains or cancels it.
      reservation.release(retainedChunkBytes);
      return {
        failClosed: true,
        // A tee may already have buffered the captured prefix into the unread
        // fallback branch. Keep that memory inside the aggregate reservation
        // until the downstream response drains or cancels the branch.
        fallback: deferUntilStreamConsumed(fallback, reservation.releaseAll),
        reason: `response body did not complete within ${CACHEABILITY_RESPONSE_CAPTURE_TIMEOUT_MS}ms`,
      };
    }
  } catch (error) {
    void fallback.cancel().catch(() => {});
    reservation.releaseAll();
    throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    removeAbortListener?.();
  }

  try {
    // Account for the contiguous result while the source chunks are still
    // retained. This bounds the short-lived copy peak as well as steady state.
    if (!reservation.tryReserve(length)) {
      void fallback.cancel().catch(() => {});
      reservation.release(retainedChunkBytes);
      return {
        failClosed: true,
        fallback: streamCapturedPrefixThenReader(chunks, reader, reservation.releaseAll),
        reason: `response capture exceeded the ${CACHEABILITY_RESPONSE_CAPTURE_BUDGET} byte isolate budget`,
      };
    }
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    chunks.length = 0;
    reservation.release(retainedChunkBytes);
    return {
      body: body.buffer,
      fallback: deferUntilStreamConsumed(fallback, () => reservation.release(length)),
      failClosed: false,
      release: () => reservation.release(length),
    };
  } catch (error) {
    reservation.releaseAll();
    void fallback.cancel().catch(() => {});
    throw error;
  }
}

export function createWorkerCacheabilityContext(
  base: ExecutionContextLike,
  request: Request,
  expectedSecret: string | null | undefined,
): ExecutionContextLike {
  const probeMode = request.headers.get(VINEXT_CACHEABILITY_PROBE_HEADER);
  const requestedProbe = probeMode === "1" || probeMode === "identity";
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
    mode: authorizedProbe
      ? probeMode === "identity"
        ? "identity"
        : "probe"
      : manifest
        ? "admit"
        : "admit-all",
    requestHeaders: Object.fromEntries(request.headers),
    requestIsRsc: request.headers.get(RSC_HEADER) === "1",
    requestMethod: request.method,
    requestPathname: new URL(request.url).pathname,
  };
  return Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
    [CACHEABILITY_REQUEST_STATE]: state,
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
  if (
    state.mode !== "probe" &&
    state.mode !== "identity" &&
    getCdnCacheAdapter().ownsBackgroundRevalidation
  ) {
    return false;
  }

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

/** True for the cheap staged pass that resolves routing without user rendering. */
export function isRouteCacheabilityIdentityProbe(): boolean {
  return readState(getRequestExecutionContext())?.mode === "identity";
}

/** A final manifest has already proven this concrete route representation dynamic. */
export function isRouteManifestProvenDynamic(): boolean {
  const state = readState(getRequestExecutionContext());
  return (
    state?.mode === "admit" &&
    (state.manifestRoute?.state === "dynamic" || state.manifestRoute?.state === "probe-failed")
  );
}

/** The request can no longer become eligible for whole-response CDN reuse. */
export function isRouteCacheabilityAlreadyUncacheable(): boolean {
  const state = readState(getRequestExecutionContext());
  return Boolean(
    state?.route &&
    (state.unsafeReason ||
      state.outcome?.cacheable === false ||
      (state.mode === "admit" &&
        (state.manifestRoute?.state === "dynamic" ||
          state.manifestRoute?.state === "probe-failed"))),
  );
}

/**
 * Unknown fallback params are request data under Cache Components. Paths
 * discovered by generateStaticParams/getStaticPaths retain static semantics.
 */
export function routeParamsRequireRuntime(fallbackWithoutManifest = false): boolean {
  const state = readState(getRequestExecutionContext());
  if (!state?.route) return fallbackWithoutManifest;
  if (!state.route.pattern.includes(":")) return false;
  if (state.mode === "probe") return false;
  return !(
    state.manifestRoute?.generatedPath === true ||
    cacheabilityManifestHasGeneratedPath(state.manifestRoute?.generatedPaths, state.requestPathname)
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

/**
 * Reuse a body already collected by the route's Full Route Cache owner.
 * Returns true once request admission has taken ownership of `release`, even
 * when a late completion must be discarded because admission already closed.
 */
export function recordRouteCacheabilityCapturedBody(
  body: ArrayBuffer | null,
  release?: () => void,
): boolean {
  const state = readState(getRequestExecutionContext());
  if (!state?.route) return false;
  if (state.closed) {
    // Transfer owns the release callback even when the request already
    // finalized. This closes the race where an asynchronous RSC capture
    // completes after a dynamic response has failed admission.
    release?.();
    return true;
  }
  state.capturedBody = body;
  if (release) (state.releaseCapturedBodies ??= new Set()).add(release);
  return true;
}

/** Retain capture capacity that belongs to a side artifact such as raw RSC. */
export function retainRouteCacheabilityCapture(release: () => void): boolean {
  const state = readState(getRequestExecutionContext());
  if (!state?.route) return false;
  if (state.closed) {
    release();
    return true;
  }
  (state.releaseCapturedBodies ??= new Set()).add(release);
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
    state.closed = true;
    for (const release of state.releaseCapturedBodies ?? []) release();
    state.releaseCapturedBodies = undefined;
  }
}

async function finalizeWorkerCacheabilityResponseWithState(
  response: Response,
  state: CacheabilityRequestState,
): Promise<Response> {
  if (state.mode === "identity") {
    void response.body?.cancel().catch(() => {});
    return probeResponse(
      state,
      state.route ? "runtime-check" : "probe-failed",
      {
        cacheable: false,
        ...(state.route ? {} : { reason: "request did not resolve to a probeable route" }),
      },
      response.status,
    );
  }
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
