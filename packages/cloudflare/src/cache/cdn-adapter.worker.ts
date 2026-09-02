import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  VinextAssetFetcher,
  VinextRequestStageTransport,
  VinextResponseStageDispatchOptions,
  VinextResponseStageTransport,
} from "vinext/server/multi-stage";
import { loadVinextRequestStage } from "vinext/server/request-stage";
import { loadVinextResponseStage } from "vinext/server/response-stage";
import { isNonCacheableCacheControl } from "vinext/shims/cdn-cache";

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
  const bytes = new TextEncoder().encode(
    `${request.url}\0${serializedInvocation}\0${authorizationIdentity}`,
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
function finalizeGatewayResponse(response: Response, usedSharedResponseStage: boolean): Response {
  const cacheControl = response.headers.get("Cache-Control");
  if (
    !response.headers.has(CLOUDFLARE_EDGE_POLICY_HEADER) &&
    (!usedSharedResponseStage || (cacheControl && isNonCacheableCacheControl(cacheControl)))
  ) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.delete(CLOUDFLARE_EDGE_POLICY_HEADER);
  if (usedSharedResponseStage) {
    headers.delete("CDN-Cache-Control");
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
  const options = Reflect.get(value, "options");
  if (!options || typeof options !== "object") return null;
  const cache = Reflect.get(options, "cache");
  if (cache !== "shared" && cache !== "bypass") return null;
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
    options: options as VinextResponseStageDispatchOptions,
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
      return new Response("Invalid vinext response-stage invocation", { status: 400 });
    }
    const restored = restoreResponseStageRequest(
      request,
      invocation.requestUrl,
      invocation.requestMethod,
    );
    const response = await invokeResponseStage(restored.request, this.env, context, invocation);
    return restored.didAccessRequestCf() ? preventRequestCfResponseCaching(response) : response;
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
    let usedSharedResponseStage = false;
    const dispatchResponseStage: VinextResponseStageTransport = async (
      stageRequest,
      props,
      options,
    ) => {
      const invocation = {
        options,
        props,
        requestMethod: stageRequest.method,
        requestUrl: stageRequest.url,
      };
      if (options.cache === "bypass") {
        return invokeResponseStage(stageRequest, env, stageContext, invocation);
      }
      usedSharedResponseStage = true;
      const serializedInvocation = JSON.stringify(invocation);
      const binding = getResponseStageBinding(stageContext, serializedInvocation);
      return binding
        ? await binding.fetch(await createCacheFacingRequest(stageRequest, serializedInvocation))
        : invokeResponseStage(stageRequest, env, stageContext, invocation);
    };
    const { handleRequestStage } = await loadVinextRequestStage<unknown, CloudflareStageContext>();
    return finalizeGatewayResponse(
      await handleRequestStage(request, env, stageContext, dispatchResponseStage),
      usedSharedResponseStage,
    );
  },
};
