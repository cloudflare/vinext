import type { ExecutionContextLike } from "vinext/shims/request-context";
import { getRequestExecutionContext } from "vinext/shims/request-context";
import { getCdnCacheAdapter, isNonCacheableCacheControl } from "vinext/shims/cdn-cache";
import { applyCdnResponseHeaders, NO_STORE_CACHE_CONTROL } from "./cache-control.js";
import {
  cacheabilityManifestHasGeneratedPath,
  cacheabilityRouteKey,
  cacheabilityRouteAllowsPath,
  getBoundCacheabilityManifest,
  getEmbeddedCacheabilityManifest,
  type CacheabilityManifest,
  type CacheabilityManifestRoute,
  type CacheabilityRouteKind,
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
import { CACHEABILITY_REQUEST_STATE } from "vinext/shims/cacheability-classification";
import { runWithoutPlatformIoTracking } from "vinext/shims/platform-io-tracking";
import {
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
  CACHEABILITY_DEPLOY_REQUEST_CONCURRENCY,
  CACHEABILITY_RESPONSE_CAPTURE_TIMEOUT_MS,
} from "./cacheability-limits.js";

export function frameworkNow(): number {
  return runWithoutPlatformIoTracking(() => Date.now());
}

export type CacheabilityOutcome = {
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

export type CacheabilityRequestState = {
  captureDeadlineAt?: number;
  capturedBody?: ArrayBuffer | null;
  capturedBodyRelease?: () => void;
  closed?: boolean;
  releaseCapturedBodies?: Set<() => void>;
  complete?: (outcome: CacheabilityOutcome) => void;
  completion?: Promise<CacheabilityOutcome>;
  explicitCachePolicy?: string;
  explicitCachePolicyHeader?: string;
  manifestOutcome?: CacheabilityOutcome;
  manifest?: CacheabilityManifest;
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
    readCacheabilityState(context) !== null
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

export async function acquireCacheabilityCaptureReader(
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

export function readCacheabilityState(
  ctx: ExecutionContextLike | null | undefined,
): CacheabilityRequestState | null {
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

export function responseHasFinalCacheOptOut(
  response: Response,
  state: CacheabilityRequestState,
): boolean {
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

export function responsePolicyIsCacheable(response: Response): boolean {
  if (!isAdmissibleCacheStatus(response.status) || response.headers.has("set-cookie")) return false;
  if (hasNonCacheablePolicy(response.headers)) return false;
  const policy = effectiveResponseCachePolicy(response.headers)?.value;
  if (!policy) return false;
  return policy
    .split(",")
    .map((directive) => directive.trim().match(/^(?:s-maxage|max-age)\s*=\s*"?(\d+)"?$/i))
    .some((match) => match !== null && Number(match[1]) > 0);
}

export function responseCachePolicy(response: Response): string | undefined {
  return effectiveResponseCachePolicy(response.headers)?.value;
}

export function explicitCachePolicyOutcome(
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

export function responseHasUnsupportedVary(response: Response): boolean {
  return (response.headers.get("Vary") ?? "")
    .split(",")
    .some((name) => name.trim() !== "" && !SUPPORTED_VARY_HEADERS.has(name.trim().toLowerCase()));
}

export function isUpgradeResponse(response: Response): boolean {
  return (
    response.status === 101 ||
    response.headers.has("Upgrade") ||
    Reflect.get(response, "webSocket") != null
  );
}

export function syntheticErrorResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const name of REPRESENTATION_HEADERS) headers.delete(name);
  applyCdnResponseHeaders(headers, { cacheControl: NO_STORE_CACHE_CONTROL });
  return new Response("Internal Server Error", { headers, status: 500 });
}

export function captureCapacityUnavailableResponse(): Response {
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

export async function reportStaticToDynamicError(
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

export function uncacheableStreamingResponse(response: Response): Response {
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

export type CacheabilityCaptureOptions = {
  onCaptureStart?: () => void;
  signal?: AbortSignal;
  waitForCapacity?: boolean;
};

/** Lazily load bounded capture so ordinary origin-managed requests avoid it. */
export async function captureResponseBodyBounded(
  response: Response,
  options: CacheabilityCaptureOptions = {},
): Promise<CapturedResponseBody> {
  const { captureResponseBodyBoundedRuntime } = await import("./cacheability-response.js");
  return captureResponseBodyBoundedRuntime(response, options);
}

export function createWorkerCacheabilityContext(
  base: ExecutionContextLike,
  request: Request,
  expectedSecret: string | null | undefined,
  manifestBinding?: string,
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
  const manifest =
    manifestBinding === undefined
      ? getEmbeddedCacheabilityManifest()
      : getBoundCacheabilityManifest(manifestBinding);
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
    ...(manifest ? { manifest } : {}),
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

/** Absolute deadline shared by every capture owned by this authenticated request. */
export function getRouteCacheabilityCaptureDeadline(): number | undefined {
  return readCacheabilityState(getRequestExecutionContext())?.captureDeadlineAt;
}

export function beginRouteCacheability(
  kind: CacheabilityRouteKind,
  pattern: string,
  options: { partialPrerender?: boolean; useManifestClassification?: boolean } = {},
): boolean {
  const state = readCacheabilityState(getRequestExecutionContext());
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
      : state.manifest?.routes;
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
  return readCacheabilityState(getRequestExecutionContext())?.mode === "probe";
}

/** True for the cheap staged pass that resolves routing without user rendering. */
export function isRouteCacheabilityIdentityProbe(): boolean {
  return readCacheabilityState(getRequestExecutionContext())?.mode === "identity";
}

/** A final manifest has already proven this concrete route representation dynamic. */
export function isRouteManifestProvenDynamic(): boolean {
  const state = readCacheabilityState(getRequestExecutionContext());
  return (
    state?.mode === "admit" &&
    (state.manifestRoute?.state === "dynamic" || state.manifestRoute?.state === "probe-failed")
  );
}

/** The request can no longer become eligible for whole-response CDN reuse. */
export function isRouteCacheabilityAlreadyUncacheable(): boolean {
  const state = readCacheabilityState(getRequestExecutionContext());
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
  const state = readCacheabilityState(getRequestExecutionContext());
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
  const state = readCacheabilityState(getRequestExecutionContext());
  if (!state || state.unsafeReason) return;
  state.unsafeReason = reason;
  if (state.route) {
    recordRouteCacheability({ cacheable: false, reason });
  }
}

export function deferRouteCacheability(): ((outcome: CacheabilityOutcome) => void) | null {
  const state = readCacheabilityState(getRequestExecutionContext());
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
  const state = readCacheabilityState(getRequestExecutionContext());
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
  const state = readCacheabilityState(getRequestExecutionContext());
  if (!state?.route) return false;
  if (state.closed) {
    // Transfer owns the release callback even when the request already
    // finalized. This closes the race where an asynchronous RSC capture
    // completes after a dynamic response has failed admission.
    release?.();
    return true;
  }
  state.capturedBodyRelease?.();
  state.capturedBody = body;
  state.capturedBodyRelease = release;
  return true;
}

/** Retain capture capacity that belongs to a side artifact such as raw RSC. */
export function retainRouteCacheabilityCapture(release: () => void): boolean {
  const state = readCacheabilityState(getRequestExecutionContext());
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
  const state = readCacheabilityState(getRequestExecutionContext());
  if (!state?.route) return;
  state.provisionalPolicy = snapshot;
}

/** Whether the current cache headers are still exactly framework-generated. */
export function isRouteCacheabilityPolicyProvisional(headers: Headers): boolean {
  const state = readCacheabilityState(getRequestExecutionContext());
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
  const state = readCacheabilityState(getRequestExecutionContext());
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
  const state = readCacheabilityState(getRequestExecutionContext());
  if (!isRouteCacheabilityPolicyProvisional(headers)) return;
  headers.delete("Cache-Control");
  headers.delete("CDN-Cache-Control");
  headers.delete("Cloudflare-CDN-Cache-Control");
  if (state?.explicitCachePolicy && state.explicitCachePolicyHeader) {
    headers.set(state.explicitCachePolicyHeader, state.explicitCachePolicy);
    state.provisionalPolicy = undefined;
  }
}

/** Lazily load response capture and admission only for edge-managed classification. */
export async function finalizeWorkerCacheabilityResponse(
  response: Response,
  ctx: ExecutionContextLike,
): Promise<Response> {
  if (!readCacheabilityState(ctx)) return response;
  const { finalizeWorkerCacheabilityResponseRuntime } = await import("./cacheability-response.js");
  return finalizeWorkerCacheabilityResponseRuntime(response, ctx);
}
