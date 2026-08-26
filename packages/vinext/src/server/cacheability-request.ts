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
  INTERNAL_HEADERS,
  VINEXT_INTERNAL_HEADERS,
} from "./headers.js";
import { workerCapabilityMatches } from "./worker-prerender-discovery.js";
import { deferUntilStreamConsumed } from "./defer-until-stream-consumed.js";
import { CACHEABILITY_REQUEST_STATE } from "vinext/shims/cacheability-classification";
import { runWithoutPlatformIoTracking } from "vinext/shims/platform-io-tracking";
import {
  CACHEABILITY_RESPONSE_BODY_LIMIT,
  CACHEABILITY_RESPONSE_CAPTURE_BUDGET,
  CACHEABILITY_RESPONSE_CAPTURE_CONCURRENCY,
  CACHEABILITY_RESPONSE_CAPTURE_PENDING_LIMIT,
  CACHEABILITY_RESPONSE_CAPTURE_TIMEOUT_MS,
} from "./cacheability-limits.js";
export {
  CacheabilityClassificationError,
  isCacheabilityClassificationError,
} from "./cacheability-classification-error.js";

export {
  CACHEABILITY_RESPONSE_BODY_LIMIT,
  CACHEABILITY_RESPONSE_CAPTURE_BUDGET,
  CACHEABILITY_RESPONSE_CAPTURE_CONCURRENCY,
  CACHEABILITY_RESPONSE_CAPTURE_MAX_IN_FLIGHT,
  CACHEABILITY_RESPONSE_CAPTURE_PENDING_LIMIT,
  CACHEABILITY_RESPONSE_CAPTURE_TIMEOUT_MS,
} from "./cacheability-limits.js";

function frameworkNow(): number {
  return runWithoutPlatformIoTracking(() => Date.now());
}

type CacheabilityOutcome = {
  cacheControl?: string;
  cacheable: boolean;
  /** Infrastructure prevented a complete classification; user code was not dynamic. */
  classificationFailure?: boolean;
  dynamicUsage?: boolean;
  reason?: string;
  tags?: readonly string[];
};

type CacheabilityRequestRoute = Pick<CacheabilityManifestRoute, "kind" | "pattern"> & {
  partialPrerender: boolean;
};

type CacheabilityRequestState = {
  captureDeadlineAt?: number;
  capturedBody?: ArrayBuffer | null;
  closed?: boolean;
  releaseCapturedBodies?: Set<() => void>;
  complete?: (outcome: CacheabilityOutcome) => void;
  completion?: Promise<CacheabilityOutcome>;
  explicitCachePolicy?: string;
  explicitCachePolicyHeader?: string;
  manifestOutcome?: CacheabilityOutcome;
  manifestRoute?: CacheabilityManifestRoute;
  mode: "admit" | "admit-all" | "identity" | "probe" | "warm";
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

let reservedCaptureBytes = 0;
let activeCaptureReaders = 0;
const frameworkCachePolicies = new WeakMap<Headers, CacheabilityPolicySnapshot>();
const pendingCaptureReaders: Array<{
  resolve: (release: (() => void) | null) => void;
  signal?: AbortSignal;
  timeout: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
}> = [];

export type CacheabilityCaptureReservation = {
  release(this: void, bytes: number): void;
  releaseAll(this: void): void;
  tryReserve(this: void, bytes: number): boolean;
};

function tracksWorkerCaptureMemory(): boolean {
  const context = getRequestExecutionContext();
  return (
    context?.hostRuntime === "worker" &&
    context.isCloudflareWorker === true &&
    context.trustedRevalidateOrigin === undefined &&
    readState(context) !== null
  );
}

export function createCacheabilityCaptureReservation(): CacheabilityCaptureReservation {
  const tracksWorkerMemory = tracksWorkerCaptureMemory();
  let ownedBytes = 0;
  return {
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

function releaseCaptureReader(): void {
  const next = pendingCaptureReaders.shift();
  if (next) {
    clearTimeout(next.timeout);
    if (next.signal && next.onAbort) next.signal.removeEventListener("abort", next.onAbort);
    next.resolve(createCaptureReaderRelease());
    return;
  }
  activeCaptureReaders = Math.max(0, activeCaptureReaders - 1);
}

function createCaptureReaderRelease(): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseCaptureReader();
  };
}

async function acquireCaptureReader(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<(() => void) | null> {
  if (!tracksWorkerCaptureMemory()) return () => {};
  if (activeCaptureReaders < CACHEABILITY_RESPONSE_CAPTURE_CONCURRENCY) {
    activeCaptureReaders += 1;
    return createCaptureReaderRelease();
  }
  if (
    signal?.aborted ||
    timeoutMs <= 0 ||
    pendingCaptureReaders.length >= CACHEABILITY_RESPONSE_CAPTURE_PENDING_LIMIT
  ) {
    return null;
  }

  return new Promise<(() => void) | null>((resolve) => {
    const waiter: (typeof pendingCaptureReaders)[number] = {
      resolve,
      signal,
      timeout: setTimeout(() => {
        const index = pendingCaptureReaders.indexOf(waiter);
        if (index >= 0) pendingCaptureReaders.splice(index, 1);
        if (signal && waiter.onAbort) signal.removeEventListener("abort", waiter.onAbort);
        resolve(null);
      }, timeoutMs),
    };
    if (signal) {
      waiter.onAbort = () => {
        const index = pendingCaptureReaders.indexOf(waiter);
        if (index >= 0) pendingCaptureReaders.splice(index, 1);
        clearTimeout(waiter.timeout);
        resolve(null);
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    }
    pendingCaptureReaders.push(waiter);
  });
}

function streamCapturedPrefixThenReader(
  prefix: Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>,
  releasePrefix: () => void,
  sourceOwnedOverflow?: Uint8Array,
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
        sourceOwnedOverflow = undefined;
        release();
        await reader.cancel(reason).catch(() => {});
      },
      async pull(controller) {
        try {
          if (index < prefix.length) {
            controller.enqueue(prefix[index++]);
            if (index === prefix.length) {
              prefix.length = 0;
              if (!sourceOwnedOverflow) release();
            }
            return;
          }
          if (sourceOwnedOverflow) {
            const chunk = sourceOwnedOverflow;
            sourceOwnedOverflow = undefined;
            controller.enqueue(chunk);
            // Keep the reader permit while the source-owned overflow is
            // retained. Releasing after enqueue bounds slow consumers too:
            // another capture cannot start until this large chunk has left
            // the stream's closure/queue.
            release();
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

function effectiveResponseCachePolicy(
  headers: Headers,
): { name: string; value: string } | undefined {
  // Cloudflare-CDN-Cache-Control is the provider-specific override and wins
  // over the generic CDN policy, which in turn wins over browser policy.
  // A browser no-store may intentionally coexist with a cacheable edge policy.
  for (const name of ["Cloudflare-CDN-Cache-Control", "CDN-Cache-Control", "Cache-Control"]) {
    const value = headers.get(name);
    if (value !== null) return { name, value };
  }
  return undefined;
}

function hasNonCacheablePolicy(headers: Headers): boolean {
  const policy = effectiveResponseCachePolicy(headers);
  return policy !== undefined && isNonCacheableCacheControl(policy.value);
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
  const policy = effectiveResponseCachePolicy(response.headers)?.value;
  if (!policy) return false;
  return policy
    .split(",")
    .map((directive) => directive.trim().match(/^(?:s-maxage|max-age)\s*=\s*"?(\d+)"?$/i))
    .some((match) => match !== null && Number(match[1]) > 0);
}

function responseCachePolicy(response: Response): string | undefined {
  return effectiveResponseCachePolicy(response.headers)?.value;
}

function explicitCachePolicyOutcome(
  response: Response,
  state: CacheabilityRequestState,
): CacheabilityOutcome | undefined {
  if (
    state.unsafeReason ||
    state.explicitCachePolicy === undefined ||
    responseCachePolicy(response) !== state.explicitCachePolicy ||
    !responsePolicyIsCacheable(response)
  ) {
    return undefined;
  }
  return { cacheable: true, cacheControl: state.explicitCachePolicy };
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

function captureCapacityUnavailableResponse(): Response {
  return new Response("Cacheability capture capacity is temporarily unavailable", {
    headers: { "Cache-Control": NO_STORE_CACHE_CONTROL, "Retry-After": "1" },
    status: 503,
  });
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
  | {
      failure: "budget" | "capacity" | "oversize" | "timeout";
      fallback: ReadableStream<Uint8Array>;
      failClosed: true;
      reason: string;
    };

/**
 * Collect a response body only while it remains within the Worker-safe size
 * and time bounds. The fallback branch preserves every byte when collection
 * must stop, allowing callers to fail cache admission without breaking the
 * streamed response.
 */
export async function captureResponseBodyBounded(
  response: Response,
  options: {
    onCaptureStart?: () => void;
    signal?: AbortSignal;
    waitForCapacity?: boolean;
  } = {},
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
      failure: "oversize",
      failClosed: true,
      fallback: response.body,
      reason: `response body exceeded ${CACHEABILITY_RESPONSE_BODY_LIMIT} bytes`,
    };
  }

  const captureStartedAt = frameworkNow();
  const requestDeadlineAt = readState(getRequestExecutionContext())?.captureDeadlineAt;
  const captureDeadlineAt = Math.min(
    captureStartedAt + CACHEABILITY_RESPONSE_CAPTURE_TIMEOUT_MS,
    requestDeadlineAt ?? Number.POSITIVE_INFINITY,
  );
  const remainingCaptureMs = (): number => Math.max(0, captureDeadlineAt - frameworkNow());
  const waitForCapacity =
    options.waitForCapacity ??
    (() => {
      const mode = readState(getRequestExecutionContext())?.mode;
      return mode === "probe" || mode === "warm";
    })();
  const releaseReader = await acquireCaptureReader(
    options.signal,
    waitForCapacity ? remainingCaptureMs() : 0,
  );
  if (!releaseReader) {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new Error("response capture was aborted");
    }
    return {
      failure: "capacity",
      failClosed: true,
      fallback: response.body,
      reason: waitForCapacity
        ? "response capture did not acquire isolate capacity before the classification deadline"
        : "response capture isolate capacity is currently unavailable",
    };
  }
  try {
    options.onCaptureStart?.();
  } catch (error) {
    releaseReader();
    throw error;
  }

  const reservation = createCacheabilityCaptureReservation();

  let captureStream: ReadableStream<Uint8Array>;
  let fallback: ReadableStream<Uint8Array>;
  try {
    [captureStream, fallback] = response.body.tee();
  } catch (error) {
    releaseReader();
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
        timeout = setTimeout(() => resolve("timed-out"), remainingCaptureMs());
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
      releaseReader();
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
        return {
          failure: readResult === "budget-exhausted" ? "budget" : "oversize",
          failClosed: true,
          fallback: streamCapturedPrefixThenReader(
            chunks,
            reader,
            () => {
              reservation.releaseAll();
              releaseReader();
            },
            overflowChunk,
          ),
          reason:
            readResult === "budget-exhausted"
              ? `response capture exceeded the ${CACHEABILITY_RESPONSE_CAPTURE_BUDGET} byte isolate budget`
              : `response body exceeded ${CACHEABILITY_RESPONSE_BODY_LIMIT} bytes`,
        };
      }
      void reader.cancel().catch(() => {});
      releaseReader();
      // Cancelling the capture branch drops one of the two retained copies;
      // the fallback keeps the other until its consumer drains or cancels it.
      reservation.release(retainedChunkBytes);
      return {
        failure: "timeout",
        failClosed: true,
        // A tee may already have buffered the captured prefix into the unread
        // fallback branch. Keep that memory inside the aggregate reservation
        // until the downstream response drains or cancels the branch.
        fallback: deferUntilStreamConsumed(fallback, reservation.releaseAll),
        reason: `response body did not complete within ${CACHEABILITY_RESPONSE_CAPTURE_TIMEOUT_MS}ms`,
      };
    }
    releaseReader();
  } catch (error) {
    releaseReader();
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
        failure: "budget",
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
  const requestedCapability = probeMode === "1" || probeMode === "identity" || probeMode === "warm";
  const authorizedCapability =
    requestedCapability &&
    Boolean(expectedSecret) &&
    workerCapabilityMatches(
      request.headers.get(VINEXT_PRERENDER_SECRET_HEADER) ?? "",
      expectedSecret ?? "",
    );
  const manifest = getEmbeddedCacheabilityManifest();
  if (
    !authorizedCapability &&
    (base.hostRuntime !== "worker" || getCdnCacheAdapter().ownsBackgroundRevalidation)
  ) {
    return base;
  }

  const diagnosticHeaders = new Headers(request.headers);
  for (const name of [...INTERNAL_HEADERS, ...VINEXT_INTERNAL_HEADERS]) {
    diagnosticHeaders.delete(name);
  }
  const state: CacheabilityRequestState = {
    mode: authorizedCapability
      ? probeMode === "identity"
        ? "identity"
        : probeMode === "warm"
          ? "warm"
          : "probe"
      : manifest
        ? "admit"
        : "admit-all",
    ...(authorizedCapability && probeMode !== "identity"
      ? { captureDeadlineAt: frameworkNow() + CACHEABILITY_RESPONSE_CAPTURE_TIMEOUT_MS }
      : {}),
    requestHeaders: Object.fromEntries(diagnosticHeaders),
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
    const reason =
      manifestRoute.state === "dynamic"
        ? "staged probe classified this route as dynamic"
        : "staged probe could not certify this route";
    // This is an automatic framework classification, not a request-safety
    // veto. A matching unconditional next.config.js cache policy remains
    // authoritative, matching Next.js's custom Cache-Control behavior.
    state.manifestOutcome = {
      cacheable: false,
      ...(manifestRoute.state === "probe-failed" ? { classificationFailure: true } : {}),
      reason,
    };
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

/** Fail admission without claiming that user code crossed a dynamic boundary. */
export function recordRouteCacheabilityClassificationFailure(reason: string): void {
  recordRouteCacheability({ cacheable: false, classificationFailure: true, reason });
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
  const snapshot = snapshotCachePolicy(headers);
  frameworkCachePolicies.set(headers, snapshot);
  const state = readState(getRequestExecutionContext());
  if (!state?.route) return;
  state.provisionalPolicy = snapshot;
}

/** Whether the current cache headers are still exactly framework-generated. */
export function isRouteCacheabilityPolicyProvisional(headers: Headers): boolean {
  const state = readState(getRequestExecutionContext());
  const responseSnapshot = frameworkCachePolicies.get(headers);
  return Boolean(
    (responseSnapshot && cachePoliciesMatch(responseSnapshot, snapshotCachePolicy(headers))) ||
    (state?.route &&
      state.provisionalPolicy &&
      cachePoliciesMatch(state.provisionalPolicy, snapshotCachePolicy(headers))),
  );
}

/** Record a matching final next.config.js cache policy as user-authoritative. */
export function markRouteCacheabilityPolicyExplicit(
  cacheControl: string,
  headerName = "Cache-Control",
): void {
  const state = readState(getRequestExecutionContext());
  if (!state) return;
  state.provisionalPolicy = undefined;
  state.explicitCachePolicy = cacheControl;
  state.explicitCachePolicyHeader = headerName;
}

/** Record the final user-authored policy carried by a Response/Node response. */
export function markRouteCacheabilityResponsePolicyExplicit(headers: Headers): void {
  const policy = effectiveResponseCachePolicy(headers);
  if (policy) markRouteCacheabilityPolicyExplicit(policy.value, policy.name);
}

/** Replace only the framework policy that an earlier explicit config policy supersedes. */
export function applyExplicitRouteCacheabilityPolicy(headers: Headers): void {
  const state = readState(getRequestExecutionContext());
  if (!isRouteCacheabilityPolicyProvisional(headers)) return;
  headers.delete("Cache-Control");
  headers.delete("CDN-Cache-Control");
  headers.delete("Cloudflare-CDN-Cache-Control");
  if (state?.explicitCachePolicy && state.explicitCachePolicyHeader) {
    headers.set(state.explicitCachePolicyHeader, state.explicitCachePolicy);
    state.provisionalPolicy = undefined;
  }
}

function probeResponse(
  state: CacheabilityRequestState,
  routeState: CacheabilityRouteState,
  outcome: CacheabilityOutcome,
  status: number,
): Response {
  const body = {
    cacheControl: outcome.cacheControl,
    ...(state.explicitCachePolicy && state.outcome?.dynamicUsage === true
      ? { explicitPolicyDynamicOverride: true }
      : {}),
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

  const authoritativePolicyOutcome = explicitCachePolicyOutcome(response, state);
  const staticCandidateBecameDynamic = (outcome: CacheabilityOutcome | undefined): boolean =>
    state.mode !== "probe" &&
    !(
      state.manifestRoute?.explicitPolicyDynamicOverride === true &&
      authoritativePolicyOutcome !== undefined
    ) &&
    state.manifestRoute?.state === "static-candidate" &&
    state.route?.partialPrerender !== true &&
    outcome?.dynamicUsage === true;
  const staticToDynamicErrorResponse = async (outcome: CacheabilityOutcome): Promise<Response> => {
    await reportStaticToDynamicError(state, outcome);
    return syntheticErrorResponse(response);
  };

  const explicitOutcome = state.manifestOutcome ?? state.outcome;
  if (staticCandidateBecameDynamic(explicitOutcome)) {
    void response.body?.cancel().catch(() => {});
    return staticToDynamicErrorResponse(explicitOutcome!);
  }
  if (state.mode === "warm" && explicitOutcome?.classificationFailure === true) {
    void response.body?.cancel().catch(() => {});
    return captureCapacityUnavailableResponse();
  }

  const isEventStream = response.headers
    .get("content-type")
    ?.toLowerCase()
    .startsWith("text/event-stream");
  const unsupportedVary = responseHasUnsupportedVary(response);
  if (
    isEventStream ||
    unsupportedVary ||
    (authoritativePolicyOutcome === undefined && explicitOutcome?.cacheable === false) ||
    responseHasFinalCacheOptOut(response, state) ||
    (!state.completion && !responsePolicyIsCacheable(response))
  ) {
    if (state.mode === "probe") {
      void response.body?.cancel().catch(() => {});
      return probeResponse(
        state,
        explicitOutcome?.classificationFailure === true ? "probe-failed" : "dynamic",
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
  const classificationFailureOutcome =
    state.manifestOutcome?.classificationFailure === true
      ? state.manifestOutcome
      : deferredOutcome?.classificationFailure === true
        ? deferredOutcome
        : state.outcome?.classificationFailure === true
          ? state.outcome
          : undefined;
  const completedOutcome =
    classificationFailureOutcome ??
    authoritativePolicyOutcome ??
    state.manifestOutcome ??
    deferredOutcome ??
    state.outcome;
  if (state.mode === "warm" && completedOutcome?.classificationFailure === true) {
    void response.body?.cancel().catch(() => {});
    return captureCapacityUnavailableResponse();
  }
  if (staticCandidateBecameDynamic(completedOutcome)) {
    void response.body?.cancel().catch(() => {});
    return staticToDynamicErrorResponse(completedOutcome!);
  }
  if (completedOutcome?.cacheable === false) {
    if (state.mode === "probe") {
      void response.body?.cancel().catch(() => {});
      return probeResponse(
        state,
        completedOutcome.classificationFailure === true ? "probe-failed" : "dynamic",
        completedOutcome,
        response.status,
      );
    }
    return uncacheableStreamingResponse(response);
  }

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
      if (state.mode === "probe") {
        void captured.fallback.cancel().catch(() => {});
        return probeResponse(
          state,
          "probe-failed",
          {
            cacheable: false,
            reason: captured.reason,
          },
          response.status,
        );
      }
      if (state.mode === "warm") {
        void captured.fallback.cancel().catch(() => {});
        return captureCapacityUnavailableResponse();
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
      completedOutcome ??
      ({
        cacheable: responsePolicyIsCacheable(response),
        cacheControl: responseCachePolicy(response),
      } satisfies CacheabilityOutcome);
    const cacheable =
      !state.unsafeReason && outcome.cacheable && !responseHasFinalCacheOptOut(response, state);

    if (state.mode === "warm" && outcome.classificationFailure === true) {
      await captured.fallback?.cancel().catch(() => {});
      return captureCapacityUnavailableResponse();
    }

    if (state.mode === "probe") {
      await captured.fallback?.cancel().catch(() => {});
      return probeResponse(
        state,
        cacheable
          ? "static-candidate"
          : outcome.classificationFailure === true
            ? "probe-failed"
            : "dynamic",
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
