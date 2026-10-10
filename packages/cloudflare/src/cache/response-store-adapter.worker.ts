import type {
  RevalidationInput,
  ResponseStoreLocationHint,
  WorkersResponseStore,
  WorkersResponseStoreClientEnv,
  WorkersResponseStoreEnv,
  WorkersResponseStoreOptions,
} from "@cloudflare/workers-response-store";
import type {
  VinextCacheFunctionInvocation,
  VinextRequestStageTransport,
  VinextResponseStageDispatchOptions,
  VinextResponseStageTransport,
} from "vinext/server/multi-stage";
import {
  VINEXT_PARAMS_HEADER,
  VINEXT_RENDERED_PATH_AND_SEARCH_HEADER,
  VINEXT_SPECIAL_ERROR_STATUS_HEADER,
} from "vinext/internal/server/headers";
import { isPageNotModified } from "vinext/internal/server/http-conditional";
import { loadVinextRequestStage } from "vinext/server/request-stage";
import { loadVinextResponseStage } from "vinext/server/response-stage";
import { traceCachedResponseStart } from "vinext/internal/server/response-start-tracing";
import {
  finalizeGatewayResponse,
  SHARED_RESPONSE_STAGE_HEADER,
  type SharedResponseStage,
} from "./browser-cache-policy.js";
import { isNonCacheableCacheControl } from "vinext/shims/cdn-cache";
import {
  applyRscCompatibilityIdHeader,
  applyRscDeploymentIdHeader,
  createCanonicalRscRequestHeaders,
  createCanonicalRscRequestUrl,
  VINEXT_RSC_CONTENT_TYPE,
  VINEXT_RSC_VARY_HEADER,
} from "vinext/internal/server/app-rsc-cache-busting";

import {
  CACHE_FUNCTION_REVALIDATOR_ID,
  captureResponseStoreDataRegeneration,
  DATA_REVALIDATOR_ID,
  runWithResponseStoreInvocation,
  setResponseStore,
  type ResponseStoreInvocationCapture,
} from "./response-store-data.runtime.js";

type WorkerExecutionContext = {
  exports?: Record<string, unknown>;
  passThroughOnException(): void;
  props?: unknown;
  waitUntil(promise: Promise<unknown>): void;
};
type StageContext = WorkerExecutionContext & {
  assets?: { fetch(request: Request): Response | Promise<Response> };
  hostRuntime?: "worker";
};
type StoredInvocation = {
  props: unknown;
  request: {
    headers: [string, string][];
    method: string;
    url: string;
  };
};
type SerializedInvocation = {
  replayable: boolean;
  serialized: string;
};

export type VinextResponseStoreEnv = WorkersResponseStoreClientEnv | WorkersResponseStoreEnv;

const ROUTE_REVALIDATOR_ID = "vinext:response";
const RESPONSE_STORE_KEY_PARAM = "__workers_response_store";
const AGE_BASIS_HEADER = "X-Workers-Response-Store-Age-Basis";
const WARMUP_USER_AGENT = "vinext-cloudflare-cdn-warm";
const REPLAY_REQUEST_HEADERS = VINEXT_RSC_VARY_HEADER.split(",").map((name) =>
  name.trim().toLowerCase(),
);
const CACHE_REQUEST_VARY_HEADERS = REPLAY_REQUEST_HEADERS.map((name): [string, string] => [
  name,
  "vinext-keyed",
]);

function stageContext(ctx: WorkerExecutionContext, env: VinextResponseStoreEnv): StageContext {
  const assets = Reflect.get(env, "ASSETS");
  return Object.assign(Object.create(Object.getPrototypeOf(ctx)), ctx, {
    ...(assets && typeof assets === "object" && typeof Reflect.get(assets, "fetch") === "function"
      ? { assets }
      : {}),
    ...(ctx.exports ? { exports: ctx.exports } : {}),
    hostRuntime: "worker" as const,
    passThroughOnException: () => ctx.passThroughOnException(),
    ...(ctx.props === undefined ? {} : { props: ctx.props }),
    waitUntil: (promise: Promise<unknown>) => ctx.waitUntil(promise),
  });
}

function safeProps(props: unknown): unknown {
  const copy = JSON.parse(JSON.stringify(props)) as unknown;
  if (copy && typeof copy === "object") {
    if ("draftModeCookie" in copy) copy.draftModeCookie = null;
    if ("middlewareCookieOverlay" in copy) copy.middlewareCookieOverlay = null;
  }
  return copy;
}

function replayHeaders(request: Request): [string, string][] {
  return REPLAY_REQUEST_HEADERS.flatMap((name): [string, string][] => {
    const value = request.headers.get(name);
    return value === null ? [] : [[name, value]];
  });
}

function isReplayableInvocation(request: Request, props: unknown): boolean {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return false;
  if (request.headers.has("authorization") || request.headers.has("cookie")) return false;
  return !(
    props &&
    typeof props === "object" &&
    (["draftModeCookie", "middlewareCookieOverlay"] as const).some(
      (name) => name in props && Reflect.get(props, name) !== null,
    )
  );
}

function prepareInvocation(request: Request, props: unknown): StoredInvocation {
  return {
    props: safeProps(props),
    request: {
      headers: replayHeaders(request),
      method: request.method,
      url: request.url,
    },
  };
}

function serializeInvocation(request: Request, props: unknown): string {
  return JSON.stringify(prepareInvocation(request, props));
}

function parseInvocation(value: unknown): StoredInvocation {
  if (typeof value !== "string") throw new TypeError("Invalid vinext response-store invocation");
  const invocation = JSON.parse(value) as StoredInvocation;
  if (
    !invocation ||
    typeof invocation !== "object" ||
    !invocation.request ||
    typeof invocation.request.url !== "string" ||
    typeof invocation.request.method !== "string" ||
    !Array.isArray(invocation.request.headers)
  ) {
    throw new TypeError("Invalid vinext response-store invocation");
  }
  return invocation;
}

function restoreRequest(invocation: StoredInvocation): Request {
  return new Request(invocation.request.url, {
    headers: invocation.request.headers,
    method: invocation.request.method,
  });
}

async function invokeRequestStage(
  request: Request,
  env: VinextResponseStoreEnv,
  ctx: WorkerExecutionContext,
): Promise<Response> {
  const { handleRequestStage } = await loadVinextRequestStage<
    VinextResponseStoreEnv,
    StageContext
  >();
  return handleRequestStage(request, env, stageContext(ctx, env), (request, props, options) =>
    invokeResponseStage(request, props, env, ctx, { cache: options.cache }),
  );
}

async function invokeResponseStage(
  request: Request,
  props: unknown,
  env: VinextResponseStoreEnv,
  ctx: WorkerExecutionContext,
  stageOptions: Pick<VinextResponseStageDispatchOptions, "cache" | "renderWholeDocument">,
  capture?: ResponseStoreInvocationCapture,
  invocation?: SerializedInvocation,
): Promise<Response> {
  const context = stageContext(ctx, env);
  const dispatchRequestStage: VinextRequestStageTransport = (request) =>
    invokeRequestStage(request, env, ctx);
  const { handleResponseStage } = await loadVinextResponseStage<
    VinextResponseStoreEnv,
    StageContext
  >();
  const storedInvocation = invocation ?? {
    replayable: isReplayableInvocation(request, props),
    serialized: serializeInvocation(request, props),
  };
  return runWithResponseStoreInvocation(
    storedInvocation.serialized,
    storedInvocation.replayable,
    () => handleResponseStage(request, env, context, props, dispatchRequestStage, stageOptions),
    capture,
  );
}

export function createVinextResponseStoreOptions<Env extends VinextResponseStoreEnv>(
  configuration?: Record<string, unknown>,
): WorkersResponseStoreOptions<Env> {
  const locationHint = configuration?.locationHint;
  if (locationHint !== undefined && typeof locationHint !== "string") {
    throw new TypeError("Workers Response Store locationHint must be a string");
  }
  const shards = configuration?.shards;
  if (shards !== undefined && typeof shards !== "number") {
    throw new TypeError("Workers Response Store shards must be a number");
  }
  return {
    ...(locationHint === undefined
      ? {}
      : { locationHint: locationHint as ResponseStoreLocationHint }),
    ...(shards === undefined ? {} : { shards }),
    async regenerate(input: RevalidationInput, { env, ctx }): Promise<Response> {
      if (input.id === ROUTE_REVALIDATOR_ID) {
        const invocation = parseInvocation(input.args.at(-1));
        // No client waits on a regeneration, so it renders the document
        // whole, as Next.js renders a static page.
        const response = await invokeResponseStage(
          restoreRequest(invocation),
          invocation.props,
          env,
          ctx,
          { cache: "shared", renderWholeDocument: true },
        );
        if (!isCacheable(response)) {
          await response.body?.cancel().catch(() => {});
          throw new Error("Vinext response-stage regeneration was not cacheable");
        }
        return withoutRequestScopedHeaders(response, invocation.props);
      }
      if (
        input.id === CACHE_FUNCTION_REVALIDATOR_ID &&
        typeof input.args[0] === "string" &&
        typeof input.args[1] === "string"
      ) {
        const invocation = JSON.parse(input.args[1]) as VinextCacheFunctionInvocation;
        if (
          !invocation ||
          typeof invocation.referenceId !== "string" ||
          typeof invocation.encryptedArgs !== "string" ||
          !invocation.rootParams ||
          typeof invocation.rootParams !== "object" ||
          !Array.isArray(invocation.softTags)
        ) {
          throw new TypeError("Invalid vinext cache function invocation");
        }
        return captureResponseStoreDataRegeneration(input.args[0], async () => {
          const responseStage = await loadVinextResponseStage<
            VinextResponseStoreEnv,
            StageContext
          >();
          if (!responseStage.invokeCacheFunction) {
            throw new Error("The vinext response stage cannot invoke cache functions");
          }
          await responseStage.invokeCacheFunction(
            invocation,
            env,
            stageContext(ctx, env),
            (request) => invokeRequestStage(request, env, ctx),
          );
        });
      }
      if (input.id === DATA_REVALIDATOR_ID && typeof input.args[0] === "string") {
        const invocation = parseInvocation(input.args.at(-1));
        return captureResponseStoreDataRegeneration(input.args[0], async () => {
          const response = await invokeResponseStage(
            restoreRequest(invocation),
            invocation.props,
            env,
            ctx,
            { cache: "bypass" },
          );
          await response.body?.pipeTo(new WritableStream());
        });
      }
      throw new Error(`Unknown vinext response-store revalidator ${input.id}`);
    },
  };
}

async function cacheRequest(invocation: StoredInvocation): Promise<Request> {
  // The stored loopback request includes transport headers that change on every
  // edge invocation; only stable response-stage selectors belong in the key.
  const identity = JSON.stringify([
    invocation.request.method,
    invocation.request.url,
    invocation.props,
    invocation.request.headers,
  ]);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity)),
  );
  const url = new URL(invocation.request.url);
  url.searchParams.set(
    RESPONSE_STORE_KEY_PARAM,
    `v1.${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`,
  );
  // The opaque URL already partitions these selectors. Keep every Vary field
  // present so cache-selection rules agree on the selected representation.
  return new Request(url, { headers: CACHE_REQUEST_VARY_HEADERS, method: "GET" });
}

/**
 * The request stage recomposes the routed params and path on every App page
 * RSC response, HITs included, so such an entry shared across queries must not
 * carry the values of the request that filled it. Every other response kind
 * (route handlers, metadata routes, HTML, Pages) keeps its headers as rendered.
 */
function withoutRequestScopedHeaders(response: Response, responseStageProps: unknown): Response {
  if (
    responseStageProps === null ||
    typeof responseStageProps !== "object" ||
    Reflect.get(responseStageProps, "kind") !== "app-page" ||
    Reflect.get(responseStageProps, "isRscRequest") !== true
  ) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.delete(VINEXT_PARAMS_HEADER);
  headers.delete(VINEXT_RENDERED_PATH_AND_SEARCH_HEADER);
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

// A page's notFound(), forbidden() and unauthorized() are stored with their
// status, as in Next.js.
function isStoredErrorStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 404;
}

function isCacheable(response: Response): boolean {
  const policy =
    response.headers.get("Cloudflare-CDN-Cache-Control") ??
    response.headers.get("CDN-Cache-Control") ??
    response.headers.get("Cache-Control");
  return (
    response.status >= 200 &&
    // A 304 answers one request's precondition; it is not the page.
    response.status !== 304 &&
    (response.status < 400 || isStoredErrorStatus(response.status)) &&
    policy !== null &&
    !isNonCacheableCacheControl(policy)
  );
}

/**
 * A page's 304 headers. Next.js sends the 304 before it sets the payload's
 * headers, so it carries no representation or body framing headers.
 */
function notModifiedHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  for (const name of ["Content-Encoding", "Content-Length", "Content-Type", "Transfer-Encoding"]) {
    headers.delete(name);
  }
  return headers;
}

/** Send the 304 for a page whose ETag matched the request's If-None-Match. */
function notModifiedResponse(response: Response): Response {
  void response.body?.cancel().catch(() => {});
  return new Response(null, { headers: notModifiedHeaders(response.headers), status: 304 });
}

/**
 * Whether Next.js sends this stored response through `sendRenderResult`, which
 * answers a conditional request by the page's ETag. It sends every App page
 * that way. A Pages redirect, and a Pages data request's notFound, are sent
 * without an ETag, as is a route handler's response. A Pages API response is
 * never stored.
 */
function answersConditionalRequest(responseStageProps: unknown, status: number): boolean {
  if (responseStageProps === null || typeof responseStageProps !== "object") return false;
  const kind = Reflect.get(responseStageProps, "kind");
  if (kind === "app-page" || kind === "app-not-found") return true;
  let isDataRequest: boolean;
  if (kind === "hybrid-pages") {
    if (Reflect.get(responseStageProps, "resourceKind") !== "page") return false;
    isDataRequest = Reflect.get(responseStageProps, "isDataRequest") === true;
  } else if (kind === "pages-page") {
    const renderOptions: unknown = Reflect.get(responseStageProps, "renderOptions");
    isDataRequest =
      renderOptions !== null &&
      typeof renderOptions === "object" &&
      Reflect.get(renderOptions, "isDataReq") === true;
  } else {
    return false;
  }
  return (status >= 200 && status < 300) || (status === 404 && !isDataRequest);
}

/** Answer a stored page's conditional request as Next.js does for a cached page. */
function storedForRequest(
  stored: Response,
  request: Request,
  responseStageProps: unknown,
): Response {
  const etag = stored.headers.get("ETag");
  return etag &&
    answersConditionalRequest(responseStageProps, stored.status) &&
    isPageNotModified(
      {
        cacheControl: request.headers.get("Cache-Control") ?? undefined,
        ifModifiedSince: request.headers.get("If-Modified-Since") ?? undefined,
        ifNoneMatch: request.headers.get("If-None-Match") ?? undefined,
      },
      etag,
    )
    ? notModifiedResponse(stored)
    : stored;
}

async function readStoredResponse(key: Request): Promise<Response | null> {
  try {
    const response = await responseStore.fetch(key);
    // The backend's marker distinguishes a stored 404 from its 404 cache miss.
    const storeStatus = response.headers.get("X-Workers-Response-Store");
    if (
      (response.status >= 200 && response.status < 400) ||
      (isStoredErrorStatus(response.status) &&
        (storeStatus === "BLOB-FRESH" || storeStatus === "BLOB-STALE"))
    )
      return response;
    void response.body?.cancel().catch(() => {});
    if (response.status === 404 && storeStatus === "MISS") {
      return null;
    }
    throw new Error(`Workers Response Store returned ${response.status}`);
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "Vinext response-store response lookup failed; treating as a cache miss",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return null;
  }
}

function publicResponse(
  response: Response,
  cacheStatus: string,
  responseStageProps: unknown,
  pendingAdmission = false,
): Response {
  const headers = new Headers(response.headers);
  const publicCacheStatus =
    cacheStatus === "HIT" && headers.get("CF-Cache-Status") === "UPDATING"
      ? "UPDATING"
      : cacheStatus;
  const ageBasis = /^(\d+):(\d+)$/.exec(headers.get(AGE_BASIS_HEADER) ?? "");
  if (cacheStatus === "HIT" && ageBasis) {
    const elapsed = (BigInt(Date.now()) - BigInt(ageBasis[1])) / 1000n;
    headers.set("Age", String(BigInt(ageBasis[2]) + (elapsed > 0n ? elapsed : 0n)));
  }
  for (const name of [
    "Cache-Tag",
    "CDN-Cache-Control",
    "CF-Cache-Status",
    "Cloudflare-CDN-Cache-Control",
    "X-Workers-Response-Store",
    AGE_BASIS_HEADER,
    "X-Workers-Response-Store-Binding-Invocation",
    "X-Workers-Response-Store-Revision",
  ]) {
    headers.delete(name);
  }
  if (publicCacheStatus) {
    headers.set("X-Nextjs-Cache", publicCacheStatus);
    headers.set("X-Vinext-Cache", publicCacheStatus);
  }
  const cacheControl = headers.get("Cache-Control");
  // Admission can still find a late dynamic API, so the browser must not keep
  // this response: a dynamic render is no-store in Next.js. This is the same
  // pending policy the framework sends when it caches the response itself.
  if (pendingAdmission && (!cacheControl || !isNonCacheableCacheControl(cacheControl, "browser"))) {
    headers.set("Cache-Control", "no-store, must-revalidate");
  }
  return traceCachedResponseStart(
    new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    }),
    publicCacheStatus ?? null,
    responseStageProps,
  );
}

let responseStore: WorkersResponseStore;

export function createVinextResponseStoreHandler(store: WorkersResponseStore) {
  responseStore = store;
  setResponseStore(store);
  return handler;
}

const handler = {
  async fetch(
    request: Request,
    env: VinextResponseStoreEnv,
    ctx: WorkerExecutionContext,
  ): Promise<Response> {
    const context = stageContext(ctx, env);
    const dispatchResponseStage: VinextResponseStageTransport = async (
      stageRequest,
      props,
      options,
    ) => {
      if (
        options.cache === "bypass" ||
        (stageRequest.method !== "GET" && stageRequest.method !== "HEAD")
      ) {
        return publicResponse(
          await invokeResponseStage(stageRequest, props, env, ctx, { cache: "bypass" }),
          "BYPASS",
          props,
        );
      }

      // Core supplies a query-free identity only for shared App page dispatches,
      // whose admission requires a negative searchParams proof. The render
      // still receives the real request; the key, route replay and RSC seed
      // use the identity.
      const identityRequest = options.cacheIdentity?.request ?? stageRequest;
      const identityProps = options.cacheIdentity?.props ?? props;
      const isWarmup = request.headers.get("user-agent") === WARMUP_USER_AGENT;
      const canSeedRsc =
        isWarmup &&
        props !== null &&
        typeof props === "object" &&
        Reflect.get(props, "kind") === "app-page" &&
        Reflect.get(props, "isRscRequest") === false &&
        Reflect.get(props, "matchKind") === "request" &&
        Reflect.get(props, "interceptionContext") === null &&
        Reflect.get(props, "interceptionId") === null &&
        Reflect.get(props, "mountedSlotsHeader") === null;
      const rscSeed = canSeedRsc
        ? {
            props: {
              ...(identityProps as Record<string, unknown>),
              isRscRequest: true,
              renderMode: "navigation",
            },
            request: new Request(
              new URL(createCanonicalRscRequestUrl(identityRequest.url), identityRequest.url),
              { headers: createCanonicalRscRequestHeaders() },
            ),
          }
        : undefined;
      const invocation = prepareInvocation(identityRequest, identityProps);
      const rscInvocation = rscSeed ? prepareInvocation(rscSeed.request, rscSeed.props) : undefined;
      const rscKey = rscInvocation ? await cacheRequest(rscInvocation) : undefined;
      const key = await cacheRequest(invocation);
      const stored = await readStoredResponse(key);
      if (stored) {
        if (!rscKey) {
          return publicResponse(storedForRequest(stored, stageRequest, props), "HIT", props);
        }

        const storedRsc = await readStoredResponse(rscKey);
        if (storedRsc) {
          void storedRsc.body?.cancel().catch(() => {});
          return publicResponse(storedForRequest(stored, stageRequest, props), "HIT", props);
        }
        void stored.body?.cancel().catch(() => {});
      }

      const capture: ResponseStoreInvocationCapture = rscSeed
        ? { captureRscData: true }
        : isWarmup
          ? {}
          : { streamResponse: true };
      const serializedInvocation = JSON.stringify(invocation);
      // Data-cache writes replay the render that produced them, real query
      // included, so they keep the full invocation.
      // No client waits on a warm-up either, so it renders the document whole.
      const rendered = await invokeResponseStage(
        stageRequest,
        props,
        env,
        ctx,
        isWarmup ? { cache: "shared", renderWholeDocument: true } : { cache: "shared" },
        capture,
        {
          replayable: isReplayableInvocation(stageRequest, props),
          serialized: options.cacheIdentity
            ? serializeInvocation(stageRequest, props)
            : serializedInvocation,
        },
      );
      // Next.js stores the page before it evaluates the ETag, so a render that
      // matched the request's If-None-Match returns the page and its 304 is
      // sent here. Admission keeps its own branch of a deferred body.
      const foreground = (response: Response) =>
        capture.notModified ? notModifiedResponse(response) : response;
      if (capture.admittedResponse) {
        ctx.waitUntil(
          capture.admittedResponse
            .then(async (admitted) => {
              if (!isCacheable(admitted)) {
                await admitted.body?.cancel().catch(() => {});
                return;
              }
              await responseStore.put(key, withoutRequestScopedHeaders(admitted, props), {
                coalesce: true,
                revalidator: { id: ROUTE_REVALIDATOR_ID, args: [serializedInvocation] },
              });
            })
            .catch((error) => {
              console.error(
                JSON.stringify({
                  message: "Vinext response-store admission failed",
                  error: error instanceof Error ? error.message : String(error),
                }),
              );
            }),
        );
        // The foreground can precede admission. Retain browser revalidation
        // until the completed response has a proven policy.
        if (!capture.notModified) return publicResponse(rendered, "MISS", props, true);
        // A 304 has no body to send ahead of admission, and it updates the
        // client's stored headers, so it carries the admitted page's policy.
        const notModified = notModifiedResponse(rendered);
        const admitted = await capture.admittedResponse.catch(() => null);
        return admitted
          ? publicResponse(
              new Response(null, { headers: notModifiedHeaders(admitted.headers), status: 304 }),
              "MISS",
              props,
            )
          : publicResponse(notModified, "MISS", props, true);
      }
      if (!isCacheable(rendered)) {
        void capture?.rscData?.catch(() => {});
        return publicResponse(foreground(rendered), "BYPASS", props);
      }
      if (rscSeed && !capture?.rscData) {
        await rendered.body?.cancel();
        throw new Error("Vinext response-store warmup did not capture the App page RSC payload");
      }

      const [foregroundBody, cacheBody] = rendered.body ? rendered.body.tee() : [null, null];
      const cacheResponse = withoutRequestScopedHeaders(new Response(cacheBody, rendered), props);
      try {
        await responseStore.put(key, cacheResponse, {
          coalesce: true,
          revalidator: { id: ROUTE_REVALIDATOR_ID, args: [serializedInvocation] },
        });
      } catch (error) {
        // Warming must confirm persistence; ordinary requests can serve the render.
        if (isWarmup) throw error;
        void cacheResponse.body?.cancel().catch(() => {});
        console.error(
          JSON.stringify({
            message: "Vinext response-store response fill failed; serving the rendered response",
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }

      if (rscSeed && rscInvocation && rscKey && capture?.rscData) {
        const rscData = await capture.rscData;
        const rscHeaders = new Headers(rendered.headers);
        rscHeaders.delete("Content-Length");
        rscHeaders.delete("Link");
        rscHeaders.delete("X-Vinext-Response-Store-Replayable");
        rscHeaders.delete(VINEXT_PARAMS_HEADER);
        rscHeaders.delete(VINEXT_RENDERED_PATH_AND_SEARCH_HEADER);
        rscHeaders.set("Content-Type", VINEXT_RSC_CONTENT_TYPE);
        rscHeaders.set("Vary", VINEXT_RSC_VARY_HEADER);
        applyRscCompatibilityIdHeader(rscHeaders);
        applyRscDeploymentIdHeader(rscHeaders);
        // The request stage sends it to a Link's segment prefetch as a 200.
        if (isStoredErrorStatus(rendered.status)) {
          rscHeaders.set(VINEXT_SPECIAL_ERROR_STATUS_HEADER, String(rendered.status));
        }
        const serializedRscInvocation = JSON.stringify(rscInvocation);
        await responseStore.put(
          rscKey,
          new Response(rscData, {
            headers: rscHeaders,
            // As in Next.js, the page's RSC payload takes its document's
            // status, except that it carries a redirect as a 200.
            status: rendered.status >= 300 && rendered.status < 400 ? 200 : rendered.status,
          }),
          {
            coalesce: true,
            revalidator: { id: ROUTE_REVALIDATOR_ID, args: [serializedRscInvocation] },
          },
        );
      }
      return publicResponse(foreground(new Response(foregroundBody, rendered)), "MISS", props);
    };

    const { handleRequestStage } = await loadVinextRequestStage<
      VinextResponseStoreEnv,
      StageContext
    >();
    const sharedResponses = new Map<string, SharedResponseStage>();
    const dispatch: VinextResponseStageTransport = async (stageRequest, props, options) => {
      const response = await dispatchResponseStage(stageRequest, props, options);
      if (options.cache !== "shared") return response;
      // Record the normalized foreground response, never the persisted object.
      const headers = new Headers(response.headers);
      const token = crypto.randomUUID();
      headers.set(SHARED_RESPONSE_STAGE_HEADER, token);
      sharedResponses.set(token, {
        headers: new Headers(headers),
      });
      return new Response(response.body, {
        headers,
        status: response.status,
        statusText: response.statusText,
      });
    };
    return finalizeGatewayResponse(
      await handleRequestStage(request, env, context, dispatch),
      sharedResponses,
      "X-Vinext-Cache",
    );
  },
};
