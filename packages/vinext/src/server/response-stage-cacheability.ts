import type { ExecutionContextLike } from "vinext/shims/request-context";
import { getCdnCacheAdapter } from "vinext/shims/cdn-cache";
import type { VinextResponseStageDispatchOptions } from "./multi-stage.js";
import type { WorkerCacheabilityProbeMode } from "./cacheability-request.js";
import type { CacheabilityRepresentation } from "./cacheability-manifest.js";

export type ResponseStageCacheabilityOptions = {
  buildId: string | null | undefined;
  cache: VinextResponseStageDispatchOptions["cache"];
  context: ExecutionContextLike;
  probeMode?: WorkerCacheabilityProbeMode | null;
  policyHeaders?: ReadonlyArray<readonly [string, string]> | null;
  /** The renderer receives policy before user Pages code and applies it itself. */
  policyHeadersAppliedBeforeRender?: boolean;
  rawManifest: string | null | undefined;
  /** The trusted route target after request-stage rewrites. */
  resolvedRoutePathname?: string;
  /** Trusted representation retained when request-stage normalization changes the URL shape. */
  representation?: CacheabilityRepresentation;
  /** Generated adapter registration, deferred until the response stage executes. */
  registerCacheAdapters(): void;
  request: Request;
};

/**
 * Run a response-stage render behind completed-response cache admission.
 *
 * Adapter registration and cacheability state live here so a shared transport
 * hit can avoid loading the response stage and its application graph entirely.
 */
export async function withResponseStageCacheability(
  options: ResponseStageCacheabilityOptions,
  render: (context: ExecutionContextLike) => Promise<Response>,
): Promise<Response> {
  options.registerCacheAdapters();
  const adapter = getCdnCacheAdapter();

  let context = options.context;
  let cacheability: typeof import("./cacheability-request.js") | undefined;
  if (options.probeMode) {
    cacheability = await import("./cacheability-request.js");
    context = cacheability.createWorkerCacheabilityProbeContext(
      context,
      options.probeMode,
      adapter.responseVary,
      options.resolvedRoutePathname,
    );
  } else if (
    options.cache === "shared" &&
    (options.rawManifest != null || adapter.requiresCompletedResponseAdmission === true)
  ) {
    cacheability = await import("./cacheability-request.js");
    context = cacheability.createWorkerCacheabilityAdmissionContext(
      context,
      options.request,
      options.rawManifest,
      options.buildId,
      adapter.requiresCompletedResponseAdmission === true,
      adapter.responseVary,
      options.resolvedRoutePathname,
      options.representation,
      { applyCompletedResponsePolicy: true },
    );
  }

  if (!cacheability) return render(context);
  if (options.policyHeadersAppliedBeforeRender) {
    cacheability.recordResponseStageCachePolicy(context, options.policyHeaders);
  }
  const rendered = await render(context);
  const response = options.policyHeadersAppliedBeforeRender
    ? rendered
    : cacheability.applyResponseStageCachePolicy(rendered, context, options.policyHeaders);
  return cacheability.finalizeWorkerCacheabilityResponse(response, context);
}
