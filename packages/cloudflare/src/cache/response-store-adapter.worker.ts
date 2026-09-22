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
import { loadVinextRequestStage } from "vinext/server/request-stage";
import { loadVinextResponseStage } from "vinext/server/response-stage";
import { traceCachedResponseStart } from "vinext/internal/server/response-start-tracing";
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
    invokeResponseStage(request, props, env, ctx, options.cache),
  );
}

async function invokeResponseStage(
  request: Request,
  props: unknown,
  env: VinextResponseStoreEnv,
  ctx: WorkerExecutionContext,
  cache: VinextResponseStageDispatchOptions["cache"],
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
    () => handleResponseStage(request, env, context, props, dispatchRequestStage, { cache }),
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
        const response = await invokeResponseStage(
          restoreRequest(invocation),
          invocation.props,
          env,
          ctx,
          "shared",
        );
        if (!isCacheable(response)) {
          await response.body?.cancel().catch(() => {});
          throw new Error("Vinext response-stage regeneration was not cacheable");
        }
        return response;
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
            "bypass",
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
  // Ordinary App Page artifacts are admitted only after a completed render.
  // A read of searchParams makes that render private, so the shared lookup can
  // discard user query values without ever writing query-dependent bytes.
  // Explicit public policies are different: they can cache dynamic output and
  // must keep the complete query in their key.
  let requestUrl = invocation.request.url;
  let props = invocation.props;
  if (props && typeof props === "object") {
    const page = props as Record<string, unknown>;
    const cacheability = page.cacheability;
    if (
      page.kind === "app-page" &&
      page.forceDynamic !== true &&
      page.mayBeClientPage !== true &&
      typeof page.resolvedUrl === "string" &&
      cacheability &&
      typeof cacheability === "object" &&
      Reflect.get(cacheability, "policyHeaders") === null
    ) {
      const url = new URL(requestUrl);
      url.search = "";
      requestUrl = url.toString();
      const resolvedUrl = new URL(page.resolvedUrl, url);
      resolvedUrl.search = "";
      props = { ...page, resolvedUrl: resolvedUrl.pathname + resolvedUrl.hash };
    }
  }
  const identity = JSON.stringify([
    invocation.request.method,
    requestUrl,
    props,
    invocation.request.headers,
  ]);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity)),
  );
  const url = new URL(requestUrl);
  url.searchParams.set(
    RESPONSE_STORE_KEY_PARAM,
    `v1.${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`,
  );
  // The opaque URL already partitions these selectors. Keep every Vary field
  // present so cache-selection rules agree on the selected representation.
  return new Request(url, { headers: CACHE_REQUEST_VARY_HEADERS, method: "GET" });
}

function isCacheable(response: Response): boolean {
  const policy =
    response.headers.get("Cloudflare-CDN-Cache-Control") ??
    response.headers.get("CDN-Cache-Control") ??
    response.headers.get("Cache-Control");
  return (
    response.status >= 200 &&
    response.status < 400 &&
    policy !== null &&
    !isNonCacheableCacheControl(policy)
  );
}

function isResponseStoreMiss(response: Response): boolean {
  return response.status === 404 && response.headers.get("X-Workers-Response-Store") === "MISS";
}

function publicResponse(
  response: Response,
  cacheStatus: string,
  responseStageProps: unknown,
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
  if (!cacheControl || !isNonCacheableCacheControl(cacheControl)) {
    headers.set("Cache-Control", "private, max-age=0, must-revalidate");
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
          await invokeResponseStage(stageRequest, props, env, ctx, "bypass"),
          "BYPASS",
          props,
        );
      }

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
              ...(props as Record<string, unknown>),
              isRscRequest: true,
              renderMode: "navigation",
            },
            request: new Request(
              new URL(createCanonicalRscRequestUrl(stageRequest.url), stageRequest.url),
              { headers: createCanonicalRscRequestHeaders() },
            ),
          }
        : undefined;
      const invocation = prepareInvocation(stageRequest, props);
      const rscInvocation = rscSeed ? prepareInvocation(rscSeed.request, rscSeed.props) : undefined;
      const rscKey = rscInvocation ? await cacheRequest(rscInvocation) : undefined;
      const key = await cacheRequest(invocation);
      const stored = await responseStore.fetch(key);
      if (!isResponseStoreMiss(stored)) {
        if (!rscKey) return publicResponse(stored, "HIT", props);

        const storedRsc = await responseStore.fetch(rscKey);
        if (!isResponseStoreMiss(storedRsc)) {
          await storedRsc.body?.cancel();
          return publicResponse(stored, "HIT", props);
        }
        await Promise.all([stored.body?.cancel(), storedRsc.body?.cancel()]);
      }

      const capture: ResponseStoreInvocationCapture = rscSeed
        ? { captureRscData: true }
        : isWarmup
          ? {}
          : { streamResponse: true };
      const serializedInvocation = JSON.stringify(invocation);
      const rendered = await invokeResponseStage(stageRequest, props, env, ctx, "shared", capture, {
        replayable: isReplayableInvocation(stageRequest, props),
        serialized: serializedInvocation,
      });
      if (capture.admittedResponse) {
        ctx.waitUntil(
          capture.admittedResponse
            .then(async (admitted) => {
              if (!isCacheable(admitted)) {
                await admitted.body?.cancel().catch(() => {});
                return;
              }
              await responseStore.put(key, admitted, {
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
        return publicResponse(rendered, "MISS", props);
      }
      if (!isCacheable(rendered)) {
        void capture?.rscData?.catch(() => {});
        return publicResponse(rendered, "BYPASS", props);
      }
      if (rscSeed && !capture?.rscData) {
        await rendered.body?.cancel();
        throw new Error("Vinext response-store warmup did not capture the App page RSC payload");
      }

      const [foreground, cacheBody] = rendered.body ? rendered.body.tee() : [null, null];
      const cacheResponse = new Response(cacheBody, rendered);
      await responseStore.put(key, cacheResponse, {
        coalesce: true,
        revalidator: { id: ROUTE_REVALIDATOR_ID, args: [serializedInvocation] },
      });

      if (rscSeed && rscInvocation && rscKey && capture?.rscData) {
        const rscData = await capture.rscData;
        const rscHeaders = new Headers(rendered.headers);
        rscHeaders.delete("Content-Length");
        rscHeaders.delete("Link");
        rscHeaders.delete("X-Vinext-Response-Store-Replayable");
        rscHeaders.set("Content-Type", VINEXT_RSC_CONTENT_TYPE);
        rscHeaders.set("Vary", VINEXT_RSC_VARY_HEADER);
        applyRscCompatibilityIdHeader(rscHeaders);
        applyRscDeploymentIdHeader(rscHeaders);
        const serializedRscInvocation = JSON.stringify(rscInvocation);
        await responseStore.put(
          rscKey,
          new Response(rscData, {
            headers: rscHeaders,
            status: 200,
          }),
          {
            coalesce: true,
            revalidator: { id: ROUTE_REVALIDATOR_ID, args: [serializedRscInvocation] },
          },
        );
      }
      return publicResponse(new Response(foreground, rendered), "MISS", props);
    };

    const { handleRequestStage } = await loadVinextRequestStage<
      VinextResponseStoreEnv,
      StageContext
    >();
    return handleRequestStage(request, env, context, dispatchResponseStage);
  },
};
