import type { ExecutionContextLike } from "vinext/shims/request-context";
import {
  CACHEABILITY_REQUEST_STATE,
  type RouteCacheabilityState,
} from "vinext/shims/cacheability-classification";
import { getCdnCacheAdapter } from "vinext/shims/cdn-cache";
import type { VinextResponseStageDispatchOptions } from "./multi-stage.js";
import type { WorkerCacheabilityProbeMode } from "./cacheability-request.js";
import type { CacheabilityRepresentation } from "./cacheability-manifest.js";
import { preserveFullyBufferedBodyMetadata } from "./fully-buffered-response.js";
import { VINEXT_PARAMS_HEADER, VINEXT_RENDERED_PATH_AND_SEARCH_HEADER } from "./headers.js";

export type ResponseStageCacheabilityOptions = {
  buildId: string | null | undefined;
  cache: VinextResponseStageDispatchOptions["cache"];
  context: ExecutionContextLike;
  forceDynamic?: boolean;
  probeMode?: WorkerCacheabilityProbeMode | null;
  policyHeaders?: ReadonlyArray<readonly [string, string]> | null;
  /** The renderer receives policy before user Pages code and applies it itself. */
  policyHeadersAppliedBeforeRender?: boolean;
  rawManifest: string | null | undefined;
  /** The trusted route target after request-stage rewrites. */
  resolvedRoutePathname?: string;
  /** Trusted representation retained when request-stage normalization changes the URL shape. */
  representation?: CacheabilityRepresentation;
  /**
   * The request stage recomposes `X-Vinext-Params` and
   * `X-Vinext-Rendered-Path-And-Search` per request (App page RSC), so a
   * shared response drops them before admission and storage.
   */
  recomposesRequestScopedHeaders?: boolean;
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

  const stripsRequestScopedHeaders =
    options.recomposesRequestScopedHeaders === true &&
    options.cache === "shared" &&
    !options.probeMode;
  if (!cacheability) {
    const rendered = await render(context);
    return stripsRequestScopedHeaders ? withoutRequestScopedHeaders(rendered) : rendered;
  }
  if (options.policyHeadersAppliedBeforeRender) {
    cacheability.recordResponseStageCachePolicy(context, options.policyHeaders);
  }
  const state = Reflect.get(context, CACHEABILITY_REQUEST_STATE) as
    | RouteCacheabilityState
    | undefined;
  if (options.probeMode && options.forceDynamic && !options.policyHeaders?.length && state) {
    state.patternDynamicReason = 'dynamic = "force-dynamic"';
  }
  const renderedResponse = await render(context);
  const rendered = stripsRequestScopedHeaders
    ? withoutRequestScopedHeaders(renderedResponse)
    : renderedResponse;
  const response = options.policyHeadersAppliedBeforeRender
    ? rendered
    : cacheability.applyResponseStageCachePolicy(rendered, context, options.policyHeaders);
  const complete = (candidate: Response) =>
    cacheability.finalizeWorkerCacheabilityResponse(candidate, context);
  const route = state?.route;
  if (
    !options.probeMode &&
    state?.admission?.policy !== "manifest" &&
    (route?.kind === "app-page" || route?.kind === "pages-page")
  ) {
    const deferred = adapter.deferCompletedPageResponseAdmission?.(response, complete);
    if (deferred) return deferred;
  }
  return complete(response);
}

function withoutRequestScopedHeaders(response: Response): Response {
  if (
    !response.headers.has(VINEXT_PARAMS_HEADER) &&
    !response.headers.has(VINEXT_RENDERED_PATH_AND_SEARCH_HEADER)
  ) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.delete(VINEXT_PARAMS_HEADER);
  headers.delete(VINEXT_RENDERED_PATH_AND_SEARCH_HEADER);
  return preserveFullyBufferedBodyMetadata(
    response,
    new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    }),
  );
}
