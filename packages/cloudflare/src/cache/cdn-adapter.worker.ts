import { WorkerEntrypoint } from "cloudflare:workers";
import {
  VINEXT_PRERENDER_READINESS_PATH,
  VINEXT_RSC_VARY_HEADER,
} from "vinext/internal/server/headers";
import type {
  VinextAssetFetcher,
  VinextRequestStageTransport,
  VinextResponseStageDispatchOptions,
  VinextResponseStageTransport,
} from "vinext/server/multi-stage";
import { loadVinextRequestStage } from "vinext/server/request-stage";
import { loadVinextResponseStage } from "vinext/server/response-stage";
import { isNonCacheableCacheControl } from "vinext/shims/cdn-cache";
import { getVinextCdnBuildIdentity, VINEXT_CDN_BUILD_ID_HEADER } from "./cdn-build-id.js";

type StageBinding = {
  fetch(request: Request): Promise<Response> | Response;
  purge?(options: CachePurgeOptions): unknown;
};

type StageBindingFactory = (options: { props: unknown }) => StageBinding;

type CloudflareStageContext = {
  assets?: VinextAssetFetcher;
  cache?: unknown;
  exports?: Record<string, unknown>;
  props?: unknown;
  hostRuntime?: "worker";
  passThroughOnException?(): void;
  waitUntil?(promise: Promise<unknown>): void;
};

type CloudflareResponseStageInvocation = {
  expectedResponseStageBuildIdentity?: string;
  options: VinextResponseStageDispatchOptions;
  props: unknown;
  requestMethod: string;
  requestUrl: string;
};

type CachePurgeOptions = { tags: string[] };

type RestoredResponseStageRequest = {
  didAccessRequestCf(): boolean;
  request: Request;
};

const RESPONSE_STAGE_EXPORT = "VinextCachedResponse";
const AUTHORIZATION_TRANSPORT_HEADER = "x-vinext-internal-authorization";
const REQUEST_CF_TRANSPORT_HEADER = "x-vinext-internal-request-cf";
const CLOUDFLARE_EDGE_POLICY_HEADER = "Cloudflare-CDN-Cache-Control";
const SHARED_RESPONSE_STAGE_HEADER = "x-vinext-cloudflare-shared-response-stage";
const RESPONSE_STAGE_WIRE_CACHE = {
  bypass: "vinext-cloudflare-v1:bypass",
  shared: "vinext-cloudflare-v1:shared",
} as const;

type ResponseStageWireCache =
  (typeof RESPONSE_STAGE_WIRE_CACHE)[keyof typeof RESPONSE_STAGE_WIRE_CACHE];
const FRAMEWORK_RESPONSE_VARY_FIELDS = new Set(
  VINEXT_RSC_VARY_HEADER.split(",").map((name) => name.trim().toLowerCase()),
);

function isResponseStageReadinessRequest(request: Request): boolean {
  return (
    request.url.includes(VINEXT_PRERENDER_READINESS_PATH) &&
    new URL(request.url).pathname === VINEXT_PRERENDER_READINESS_PATH
  );
}

function responseStageUnavailable(): Response {
  return new Response(null, {
    status: 503,
    headers: { "Cache-Control": "no-store" },
  });
}

/** Stamp the entrypoint that actually produced a response, before Workers Cache stores it. */
function stampResponseStageBuildIdentity(response: Response): Response {
  const buildIdentity = getVinextCdnBuildIdentity();
  // Direct source consumers and unit tests do not pass through vinext's build
  // defines. Production multi-stage output always has this opaque identity.
  if (!buildIdentity) return response;
  try {
    response.headers.set(VINEXT_CDN_BUILD_ID_HEADER, buildIdentity);
    return response;
  } catch {
    const headers = new Headers(response.headers);
    headers.set(VINEXT_CDN_BUILD_ID_HEADER, buildIdentity);
    return new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  }
}

/** Reject a response routed to an entrypoint from another propagating build. */
function validateResponseStageBuildIdentity(response: Response): Response {
  const expectedBuildIdentity = getVinextCdnBuildIdentity();
  if (
    !expectedBuildIdentity ||
    response.headers.get(VINEXT_CDN_BUILD_ID_HEADER) === expectedBuildIdentity
  ) {
    return response;
  }
  // The stale response must not continue producing bytes after the gateway has
  // replaced it. Cancellation is best-effort and must not delay the 503.
  void response.body?.cancel().catch(() => {});
  return responseStageUnavailable();
}

function stripUntrustedTransportHeaders(request: Request): Request {
  if (
    !request.headers.has(AUTHORIZATION_TRANSPORT_HEADER) &&
    !request.headers.has(REQUEST_CF_TRANSPORT_HEADER)
  ) {
    return request;
  }
  const headers = new Headers(request.headers);
  headers.delete(AUTHORIZATION_TRANSPORT_HEADER);
  headers.delete(REQUEST_CF_TRANSPORT_HEADER);
  const sanitized = new Request(request, { headers });
  const requestCf = Reflect.get(request, "cf");
  if (requestCf !== undefined) {
    Object.defineProperty(sanitized, "cf", {
      configurable: true,
      enumerable: true,
      value: requestCf,
    });
  }
  return sanitized;
}

function withWorkerHostRuntime(
  context: CloudflareStageContext | undefined,
  env?: unknown,
): CloudflareStageContext {
  const candidateAssets =
    env && typeof env === "object" && Reflect.has(env, "ASSETS")
      ? Reflect.get(env, "ASSETS")
      : undefined;
  const assets =
    candidateAssets &&
    (typeof candidateAssets === "object" || typeof candidateAssets === "function") &&
    Reflect.has(candidateAssets, "fetch") &&
    typeof Reflect.get(candidateAssets, "fetch") === "function"
      ? (candidateAssets as VinextAssetFetcher)
      : context?.assets;

  return {
    ...(assets === undefined ? {} : { assets }),
    ...(context?.cache === undefined ? {} : { cache: context.cache }),
    ...(context?.exports === undefined ? {} : { exports: context.exports }),
    hostRuntime: "worker",
    ...(typeof context?.passThroughOnException === "function"
      ? { passThroughOnException: () => context.passThroughOnException?.() }
      : {}),
    ...(context?.props === undefined ? {} : { props: context.props }),
    ...(typeof context?.waitUntil === "function"
      ? { waitUntil: (promise: Promise<unknown>) => context.waitUntil?.(promise) }
      : {}),
  };
}

function hasFetch(value: unknown): value is StageBinding {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    "fetch" in value &&
    typeof value.fetch === "function"
  );
}

function hasPurge(value: unknown): value is Required<Pick<StageBinding, "purge">> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    "purge" in value &&
    typeof value.purge === "function"
  );
}

function getResponseStageBinding(
  context: CloudflareStageContext,
  serializedInvocation: string,
): StageBinding | null {
  const binding = context.exports?.[RESPONSE_STAGE_EXPORT];
  if (typeof binding !== "function") return null;

  // Configurable-entrypoint props cross a Workers RPC boundary. Some vinext
  // route metadata objects intentionally use null prototypes, which are valid
  // in-process but are not supported by Workers RPC serialization. Normalize
  // the transport contract to plain JSON data at the adapter boundary.
  const props = JSON.parse(serializedInvocation) as CloudflareResponseStageInvocation;
  const target = (binding as StageBindingFactory)({ props });
  return hasFetch(target) ? target : null;
}

async function createCacheFacingRequest(
  request: Request,
  serializedInvocation: string,
): Promise<Request> {
  const authorization = request.headers.get("Authorization");
  let serializedRequestCf: string | null = null;
  const requestCf = Reflect.get(request, "cf");
  if (requestCf !== undefined) {
    try {
      const json = JSON.stringify(requestCf);
      if (json !== undefined) serializedRequestCf = encodeURIComponent(json);
    } catch {
      // A non-serializable platform extension cannot safely cross the stage.
    }
  }
  // Incoming `request.cf` describes the caller/connection, not the public
  // representation. Keep it available to a cold response-stage render without
  // fragmenting warmed cache entries by colo, geography, TCP RTT, or bot data.
  // Workers Cache automatically bypasses requests carrying Authorization, so
  // transport that value under a private header and partition the opaque URL
  // key by its digest instead.
  // https://developers.cloudflare.com/workers/cache/#what-gets-cached
  const authorizationIdentity =
    authorization === null ? "absent" : `present:${authorization.length}:${authorization}`;
  // Workers Cache keeps Vary variants under one URL, and requires every
  // variant of that URL to carry identical Cache-Tag values. App RSC variants
  // can collect different tags, so promote the complete framework selector
  // tuple into the opaque primary key instead of relying on Vary alone.
  const frameworkVaryIdentity = JSON.stringify(
    [...FRAMEWORK_RESPONSE_VARY_FIELDS].map((name) => [name, request.headers.get(name)]),
  );
  const responseStageBuildIdentity = getVinextCdnBuildIdentity() ?? "";
  const bytes = new TextEncoder().encode(
    `${request.url}\0${serializedInvocation}\0${authorizationIdentity}\0${frameworkVaryIdentity}\0${responseStageBuildIdentity}`,
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const key = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const url = new URL(request.url);
  url.searchParams.set("__vinext_cache_key", key);
  const headers = new Headers(request.headers);
  headers.delete("Authorization");
  headers.delete(AUTHORIZATION_TRANSPORT_HEADER);
  headers.delete(REQUEST_CF_TRANSPORT_HEADER);
  if (authorization !== null) {
    headers.set(AUTHORIZATION_TRANSPORT_HEADER, encodeURIComponent(authorization));
  }
  if (serializedRequestCf !== null) {
    headers.set(REQUEST_CF_TRANSPORT_HEADER, serializedRequestCf);
  }
  const init = {
    // Explicitly replace inherited inbound `cf` metadata. In workerd,
    // Request-from-Request construction otherwise preserves values such as a
    // caller-supplied cacheKey. The response stage receives the original
    // platform metadata through the authenticated internal header above.
    cf: { vary: { default: { action: "passthrough" } } },
    headers,
  } satisfies RequestInit & {
    cf: { vary: { default: { action: "passthrough" } } };
  };
  return new Request(new Request(url, request), init);
}

function restoreResponseStageRequest(
  request: Request,
  requestUrl: string,
  requestMethod: string,
): RestoredResponseStageRequest {
  const headers = new Headers(request.headers);
  const serializedAuthorization = headers.get(AUTHORIZATION_TRANSPORT_HEADER);
  const serializedRequestCf = headers.get(REQUEST_CF_TRANSPORT_HEADER);
  headers.delete("Authorization");
  headers.delete(AUTHORIZATION_TRANSPORT_HEADER);
  headers.delete(REQUEST_CF_TRANSPORT_HEADER);
  if (serializedAuthorization !== null) {
    try {
      headers.set("Authorization", decodeURIComponent(serializedAuthorization));
    } catch {
      // Malformed internal metadata is stripped rather than exposed to userland.
    }
  }
  let requestCf: unknown;
  if (serializedRequestCf !== null) {
    try {
      requestCf = JSON.parse(decodeURIComponent(serializedRequestCf));
    } catch {
      // Malformed internal metadata is stripped rather than exposed to userland.
    }
  }
  const restored = new Request(new Request(requestUrl, request), {
    headers,
    method: requestMethod,
  });
  let didAccessRequestCf = false;
  if (requestCf !== undefined) {
    // Keep provider metadata available to user code without making it part of
    // the shared cache identity. Core request reconstruction preserves this
    // accessor lazily, so only an application read flips the admission veto.
    Object.defineProperty(restored, "cf", {
      configurable: true,
      enumerable: true,
      get() {
        didAccessRequestCf = true;
        return requestCf;
      },
    });
  }
  return {
    didAccessRequestCf: () => didAccessRequestCf,
    request: restored,
  };
}

function preventRequestCfResponseCaching(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.delete("CDN-Cache-Control");
  headers.delete("Cloudflare-CDN-Cache-Control");
  headers.delete("Cache-Tag");
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

/**
 * Cloudflare consumes its private cache policy before returning a cached
 * entrypoint response. Strip it here as well for uncached/local fallbacks so
 * the outer gateway never forwards an inner shared-cache policy after adding
 * request-specific middleware or routing headers.
 */
function markSharedResponseStage(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set(SHARED_RESPONSE_STAGE_HEADER, "1");
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function finalizeGatewayResponse(response: Response): Response {
  const usedSharedResponseStage = response.headers.get(SHARED_RESPONSE_STAGE_HEADER) === "1";
  const cacheControl = response.headers.get("Cache-Control");
  if (!response.headers.has(CLOUDFLARE_EDGE_POLICY_HEADER) && !usedSharedResponseStage) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.delete(SHARED_RESPONSE_STAGE_HEADER);
  headers.delete(CLOUDFLARE_EDGE_POLICY_HEADER);
  if (usedSharedResponseStage) {
    headers.delete("CDN-Cache-Control");
    headers.delete("Cache-Tag");
    if (!cacheControl || !isNonCacheableCacheControl(cacheControl)) {
      headers.set("Cache-Control", "private, max-age=0, must-revalidate");
    }
  }
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function withResponseStagePurge(context: CloudflareStageContext): CloudflareStageContext {
  const factory = context.exports?.[RESPONSE_STAGE_EXPORT];
  if (typeof factory !== "function") return context;
  const fallback = context.cache;
  return {
    ...context,
    cache: {
      purge(options: CachePurgeOptions) {
        const target = (factory as StageBindingFactory)({ props: {} });
        if (hasPurge(target)) return target.purge(options);
        return hasPurge(fallback) ? fallback.purge(options) : undefined;
      },
    },
  };
}

function getResponseStageInvocation(value: unknown): CloudflareResponseStageInvocation | null {
  if (!value || typeof value !== "object") return null;
  const expectedResponseStageBuildIdentity = Reflect.get(
    value,
    "expectedResponseStageBuildIdentity",
  );
  if (
    expectedResponseStageBuildIdentity !== undefined &&
    typeof expectedResponseStageBuildIdentity !== "string"
  ) {
    return null;
  }
  const options = Reflect.get(value, "options");
  if (!options || typeof options !== "object") return null;
  const wireCache = Reflect.get(options, "cache");
  let cache: VinextResponseStageDispatchOptions["cache"];
  if (
    expectedResponseStageBuildIdentity !== undefined &&
    wireCache === RESPONSE_STAGE_WIRE_CACHE.shared
  ) {
    cache = "shared";
  } else if (
    expectedResponseStageBuildIdentity !== undefined &&
    wireCache === RESPONSE_STAGE_WIRE_CACHE.bypass
  ) {
    cache = "bypass";
  } else if (
    expectedResponseStageBuildIdentity === undefined &&
    getVinextCdnBuildIdentity() === null &&
    (wireCache === "shared" || wireCache === "bypass")
  ) {
    // Preserve direct source consumers and unit tests. Every built stage must
    // use the versioned discriminator so either side of a rolling deployment
    // rejects a pre-protocol peer before render or cache admission.
    cache = wireCache;
  } else {
    return null;
  }
  const requestUrl = Reflect.get(value, "requestUrl");
  if (typeof requestUrl !== "string") return null;
  const requestMethod = Reflect.get(value, "requestMethod");
  if (typeof requestMethod !== "string" || requestMethod.length === 0) return null;
  try {
    new URL(requestUrl);
  } catch {
    return null;
  }
  return {
    ...(typeof expectedResponseStageBuildIdentity === "string"
      ? { expectedResponseStageBuildIdentity }
      : {}),
    options: { ...options, cache } as VinextResponseStageDispatchOptions,
    props: Reflect.get(value, "props"),
    requestMethod,
    requestUrl,
  };
}

async function invokeResponseStage(
  request: Request,
  env: unknown,
  context: CloudflareStageContext,
  invocation: CloudflareResponseStageInvocation,
): Promise<Response> {
  const dispatchResponseStage: VinextResponseStageTransport = (stageRequest, props, options) =>
    invokeResponseStage(stageRequest, env, context, {
      options,
      props,
      requestMethod: stageRequest.method,
      requestUrl: stageRequest.url,
    });
  const dispatchRequestStage: VinextRequestStageTransport = async (stageRequest) => {
    const { handleRequestStage } = await loadVinextRequestStage<unknown, CloudflareStageContext>();
    return handleRequestStage(stageRequest, env, context, dispatchResponseStage);
  };
  const { handleResponseStage } = await loadVinextResponseStage<unknown, CloudflareStageContext>();
  return handleResponseStage(
    request,
    env,
    context,
    invocation.props,
    dispatchRequestStage,
    invocation.options,
  );
}

/** Cache-bearing entrypoint. Workers Cache HITs bypass this class entirely. */
export class VinextCachedResponse extends WorkerEntrypoint<unknown, unknown> {
  async fetch(request: Request): Promise<Response> {
    const context = withWorkerHostRuntime(this.ctx, this.env);
    const invocation = getResponseStageInvocation(context.props);
    if (!invocation) {
      return stampResponseStageBuildIdentity(
        new Response("Invalid vinext response-stage invocation", {
          status: 400,
          headers: { "Cache-Control": "no-store" },
        }),
      );
    }
    if (
      invocation.expectedResponseStageBuildIdentity !== undefined &&
      invocation.expectedResponseStageBuildIdentity !== getVinextCdnBuildIdentity()
    ) {
      return stampResponseStageBuildIdentity(responseStageUnavailable());
    }
    const restored = restoreResponseStageRequest(
      request,
      invocation.requestUrl,
      invocation.requestMethod,
    );
    const response = await invokeResponseStage(restored.request, this.env, context, invocation);
    return stampResponseStageBuildIdentity(
      restored.didAccessRequestCf() ? preventRequestCfResponseCaching(response) : response,
    );
  }

  async purge(options: CachePurgeOptions): Promise<unknown> {
    const cache = Reflect.get(this.ctx, "cache");
    if (!hasPurge(cache)) return undefined;
    return cache.purge(options);
  }
}

/** Uncached gateway: request routing and middleware always execute here. */
export default {
  async fetch(
    request: Request,
    env: unknown,
    context: CloudflareStageContext | undefined,
  ): Promise<Response> {
    request = stripUntrustedTransportHeaders(request);
    const stageContext = withResponseStagePurge(withWorkerHostRuntime(context, env));
    const dispatchResponseStage: VinextResponseStageTransport = async (
      stageRequest,
      props,
      options,
    ) => {
      const expectedResponseStageBuildIdentity = getVinextCdnBuildIdentity();
      const invocation = {
        ...(expectedResponseStageBuildIdentity === null
          ? {}
          : { expectedResponseStageBuildIdentity }),
        options,
        props,
        requestMethod: stageRequest.method,
        requestUrl: stageRequest.url,
      };
      const requiresEntrypoint = isResponseStageReadinessRequest(stageRequest);
      if (options.cache === "bypass" && !requiresEntrypoint) {
        return invokeResponseStage(stageRequest, env, stageContext, invocation);
      }
      try {
        const serializedInvocation = JSON.stringify({
          ...invocation,
          options:
            expectedResponseStageBuildIdentity === null
              ? options
              : {
                  ...options,
                  cache: RESPONSE_STAGE_WIRE_CACHE[options.cache] satisfies ResponseStageWireCache,
                },
        });
        const binding = getResponseStageBinding(stageContext, serializedInvocation);
        if (!binding) {
          return requiresEntrypoint
            ? responseStageUnavailable()
            : markSharedResponseStage(
                await invokeResponseStage(stageRequest, env, stageContext, invocation),
              );
        }
        const entrypointRequest = requiresEntrypoint
          ? stageRequest
          : await createCacheFacingRequest(stageRequest, serializedInvocation);
        const response = validateResponseStageBuildIdentity(await binding.fetch(entrypointRequest));
        return requiresEntrypoint ? response : markSharedResponseStage(response);
      } catch (error) {
        if (requiresEntrypoint) return responseStageUnavailable();
        throw error;
      }
    };
    const { handleRequestStage } = await loadVinextRequestStage<unknown, CloudflareStageContext>();
    return finalizeGatewayResponse(
      await handleRequestStage(request, env, stageContext, dispatchResponseStage),
    );
  },
};
