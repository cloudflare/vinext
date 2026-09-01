import type { ExecutionContextLike } from "vinext/shims/request-context";
import { getCdnCacheAdapter } from "vinext/shims/cdn-cache";
import type { VinextResponseStageDispatchOptions } from "./multi-stage.js";
import type { WorkerCacheabilityProbeMode } from "./cacheability-request.js";

export type ResponseStageCacheabilityOptions = {
  buildId: string | null | undefined;
  cache: VinextResponseStageDispatchOptions["cache"];
  context: ExecutionContextLike;
  probeMode?: WorkerCacheabilityProbeMode | null;
  rawManifest: string | null | undefined;
  /** The trusted route target after request-stage rewrites. */
  resolvedRoutePathname?: string;
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
  if (options.probeMode) {
    const cacheability = await import("./cacheability-request.js");
    context = cacheability.createWorkerCacheabilityProbeContext(
      context,
      options.probeMode,
      adapter.responseVary,
    );
    const response = await render(context);
    return cacheability.finalizeWorkerCacheabilityResponse(response, context);
  }

  const requiresAdmission =
    options.cache === "shared" &&
    (options.rawManifest != null || adapter.requiresCompletedResponseAdmission === true);
  if (requiresAdmission) {
    const cacheability = await import("./cacheability-request.js");
    context = cacheability.createWorkerCacheabilityAdmissionContext(
      context,
      options.request,
      options.rawManifest,
      options.buildId,
      adapter.requiresCompletedResponseAdmission === true,
      adapter.responseVary,
      options.resolvedRoutePathname,
    );
    const response = await render(context);
    return cacheability.finalizeWorkerCacheabilityResponse(response, context);
  }

  return render(context);
}
