import type { CacheabilityRepresentation } from "./cacheability-manifest.js";

/** Whether a response-stage cache must reject a field it did not key itself by. */
export function hasUnsupportedResponseStageVary(
  headers: Headers,
  keyedRequestHeaders: Iterable<string> = [],
): boolean {
  const keyedFields = new Set(
    [...keyedRequestHeaders].map((name) => name.trim().toLowerCase()).filter(Boolean),
  );
  return (headers.get("Vary") ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean)
    .some((name) => name === "*" || !keyedFields.has(name));
}

/**
 * Transport-neutral cache intent passed from the request stage to an
 * adapter-owned response-stage transport.
 */
export type VinextResponseStageDispatchOptions = {
  /**
   * Whether the adapter may use its shared response transport. Bypassed work
   * still uses the same response stage, but must not pass through a host cache.
   * Without a `cacheIdentity`, a shared transport must partition its baseline
   * lookup by the request method, complete request URL (including scheme,
   * authority, exact path, and query), plus the complete serialized stage
   * props; each can affect handler selection or response bytes.
   * Framework-managed selectors are already represented by that URL and the
   * serialized props. A verbatim-capable transport must partition stored
   * variants by every named `Vary` request header and never store `Vary: *`.
   * Other transports must reject application-defined variance themselves or
   * opt into completed-response admission and honor core's `no-store` policy.
   */
  cache: "shared" | "bypass";
  /**
   * Query-free identity of a shared App page GET/HEAD dispatch, supplied only
   * to adapters that declare `responseStageCacheIdentity: "query-free"` and
   * require completed-response admission. A transport given one partitions
   * its baseline lookup and stored entry by this request's method and complete
   * URL plus these complete serialized props, instead of the dispatched request
   * and props, and replays this identity for background regeneration.
   * Everything else in the contract above still applies.
   *
   * The identity drops the user query from the URL and `resolvedUrl`, keeping
   * framework representation selectors: the `.rsc` suffix, the `_rsc`
   * parameter, and the render mode. That is safe only because completed-response
   * admission refuses a cacheable App page response unless its render proved
   * it never read `searchParams`. The dispatched request still carries the real
   * query for the render itself. Core omits the identity when a `next.config`
   * public cache policy applies (cached per full URL, as Next.js CDN caching
   * is), and for bypassed, interception, and mounted-slot dispatches.
   */
  cacheIdentity?: {
    props: unknown;
    request: Request;
  };
};

export type VinextCacheabilityProbeMode = "probe" | "identity";

/** A durably replayable invocation of a transformed public `"use cache"` function. */
export type VinextCacheFunctionInvocation = {
  encryptedArgs: string;
  referenceId: string;
  rootParams: Record<string, string | string[]>;
  softTags: string[];
};

/** Trusted route/admission metadata transported independently of user headers. */
export type VinextResponseStageCacheability = {
  /** Safe positive next.config policy needed for CDN-level Next.js parity. */
  policyHeaders: Array<[string, string]> | null;
  /** Present only after the request stage authenticates an internal probe. */
  probeMode: VinextCacheabilityProbeMode | null;
  /** Resolved route pathname used for manifest authorization after outer rewrites. */
  resolvedRoutePathname: string;
  /** Trusted representation retained when request-stage normalization changes the URL shape. */
  representation?: CacheabilityRepresentation;
};

/**
 * Adapter-owned transport from the request stage to the response stage.
 *
 * The props and options are serializable stage metadata. An adapter may carry
 * them over in-process dispatch, platform RPC, a service binding, or HTTP. If
 * it caches shared dispatches, its baseline identity must include the request
 * method, complete request URL (including scheme, authority, exact path, and
 * query), plus the complete serialized props, or the equivalent fields of
 * `options.cacheIdentity` when core supplies one. An adapter that advertises
 * `responseVary: "verbatim"` must also partition stored variants by every
 * request header named in the returned `Vary` fields and reject `Vary: *` from
 * storage. Adapters without that capability must reject application-defined
 * variance themselves, or opt into completed-response admission and honor
 * core's resulting `no-store` policy.
 *
 * The transport is also the trust boundary for this metadata. It must
 * authenticate both directions and integrity-protect the serialized props,
 * dispatch options, and response so public callers cannot forge trusted route
 * or cache-admission state. Platform bindings can provide that boundary
 * directly; HTTP transports need equivalent authenticated, confidential
 * transport for both request-stage and response-stage endpoints.
 */
export type VinextResponseStageTransport<Props = unknown> = (
  request: Request,
  props: Props,
  options: VinextResponseStageDispatchOptions,
) => Promise<Response>;

/** Adapter-selected server output for an adapter-owned staged runtime. */
export type VinextMultiStageOutput = {
  /** Adapter-owned module that becomes the deployment entry when selected. */
  entry: string;
  /** Complete adapter-owned host entries for independently deployable stages. */
  entries?: {
    request: string;
    response: string;
  };
  type: "multi-stage";
  /** Decide whether the current build host supports this adapter's transport. */
  matchesBuild?: (build: { plugins: readonly { name?: string }[] }) => boolean;
  /** Decorate a host entry without exposing transport-specific exports to core. */
  transformHostEntry?: (module: { code: string; id: string }) => string | null;
  /**
   * Let the adapter finalize host-owned deployment output after it is written.
   * Core supplies paths only; the adapter owns every platform-specific detail.
   */
  finalizeBuildOutput?: (output: {
    outDir: string;
    root: string;
    isPrimaryServerOutput: boolean;
  }) => Promise<void> | void;
};

/** Platform-neutral request-stage handler exposed to deployment adapters. */
export type VinextRequestStageHandler<Env = unknown, Context = unknown> = (
  request: Request,
  env: Env,
  context: Context,
  dispatchResponseStage: VinextResponseStageTransport,
) => Promise<Response>;

/** Adapter-owned reverse transport from a response stage back through request routing. */
export type VinextRequestStageTransport = (request: Request) => Promise<Response>;

/** Adapter-supplied host capability for serving deployment assets. */
export type VinextAssetFetcher = {
  fetch(request: Request): Promise<Response> | Response;
};

/** Optional host capabilities consumed by a platform-neutral request stage. */
export type VinextRequestStageContext = {
  assets?: VinextAssetFetcher;
};

/** Platform-neutral response-stage handler exposed to deployment adapters. */
export type VinextResponseStageHandler<Env = unknown, Context = unknown> = (
  request: Request,
  env: Env,
  context: Context,
  props: unknown,
  dispatchRequestStage: VinextRequestStageTransport,
  options: VinextResponseStageDispatchOptions,
) => Promise<Response>;

export type VinextRequestStageModule<Env = unknown, Context = unknown> = {
  handleRequestStage: VinextRequestStageHandler<Env, Context>;
};

export type VinextResponseStageModule<Env = unknown, Context = unknown> = {
  handleResponseStage: VinextResponseStageHandler<Env, Context>;
  invokeCacheFunction?: (
    invocation: VinextCacheFunctionInvocation,
    env: Env,
    context: Context,
    dispatchRequestStage: VinextRequestStageTransport,
  ) => Promise<void>;
};
