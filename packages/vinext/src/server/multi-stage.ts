import type { CacheabilityRepresentation } from "./cacheability-manifest.js";

const FRAMEWORK_RESPONSE_STAGE_VARY_FIELDS = new Set([
  "rsc",
  "next-router-state-tree",
  "next-router-prefetch",
  "next-router-segment-prefetch",
  "next-url",
  "x-vinext-interception-context",
  "x-vinext-interception-id",
  "x-vinext-mounted-slots",
  "x-vinext-rsc-render-mode",
  "x-vinext-rsc-state-fingerprint",
]);

/** Whether a header-blind response-stage cache must reject this response. */
export function hasUnsupportedResponseStageVary(headers: Headers): boolean {
  return (headers.get("Vary") ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean)
    .some((name) => name === "*" || !FRAMEWORK_RESPONSE_STAGE_VARY_FIELDS.has(name));
}

/**
 * Transport-neutral cache intent passed from the request stage to an
 * adapter-owned response-stage transport.
 */
export type VinextResponseStageDispatchOptions = {
  /**
   * Whether the adapter may use its shared response transport. Bypassed work
   * still uses the same response stage, but must not pass through a host cache.
   * A shared transport must partition its baseline lookup by the request
   * method, complete request URL (including scheme, authority, exact path, and
   * query), plus the complete serialized stage props; each can affect handler
   * selection or response bytes. Framework-managed selectors are already
   * represented by that URL and the
   * serialized props. A verbatim-capable transport must partition stored
   * variants by every named `Vary` request header and never store `Vary: *`.
   * Other transports must reject application-defined variance themselves or
   * opt into completed-response admission and honor core's `no-store` policy.
   */
  cache: "shared" | "bypass";
};

export type VinextCacheabilityProbeMode = "probe" | "identity";

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
 * query), plus the complete serialized props. An adapter that advertises
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
};
