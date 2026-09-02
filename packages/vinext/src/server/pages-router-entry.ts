/** Router-specific single-entry Worker facade for vinext Pages Router. */

import {
  handleRequestStageLocally,
  pagesRequestStageBuildId,
  pagesRequestStagePrerenderSecret,
  type PagesWorkerEnv,
  type PagesWorkerExecutionContext,
} from "./pages-request-stage-entry.js";
import { renderPagesResponse } from "./pages-response-stage-entry.js";
import { getCdnCacheAdapter } from "vinext/shims/cdn-cache";
import { createWorkerRevalidationContext } from "./worker-revalidation-context.js";
import {
  createWorkerPrerenderDiscoveryContext,
  createWorkerPrerenderReadinessResponse,
} from "./worker-prerender-discovery.js";
import {
  VINEXT_CACHEABILITY_PROBE_HEADER,
  VINEXT_CACHEABILITY_PROBE_QUERY_PARAM,
} from "./headers.js";
import { cloneRequestWithHeaders, cloneRequestWithUrl } from "./request-pipeline.js";
import { validateCdnRequest } from "./cache-control.js";

// @ts-expect-error -- virtual module resolved by vinext at build time
import { registerConfiguredCacheAdapters } from "virtual:vinext-cache-adapters";
// @ts-expect-error -- virtual module resolved by vinext at build time
import __cacheabilityManifest from "virtual:vinext-cacheability-manifest";

async function handleSingleStageRequest(
  request: Request,
  env: PagesWorkerEnv | undefined,
  platformCtx: PagesWorkerExecutionContext | undefined,
): Promise<Response> {
  const ctxWithRevalidation = createWorkerRevalidationContext(
    platformCtx,
    (internalRequest, internalCtx) =>
      handleSingleStageRequest(internalRequest, env, internalCtx as PagesWorkerExecutionContext),
    "worker",
  );
  registerConfiguredCacheAdapters(env);
  const adapter = getCdnCacheAdapter();
  let ctx = createWorkerPrerenderDiscoveryContext(
    ctxWithRevalidation,
    request,
    pagesRequestStagePrerenderSecret,
  );
  const readinessResponse = createWorkerPrerenderReadinessResponse(ctx, request);
  if (readinessResponse) {
    return (await validateCdnRequest(request)) ?? readinessResponse;
  }

  let finalize: ((response: Response, context: typeof ctx) => Promise<Response>) | undefined;
  if (request.headers.has(VINEXT_CACHEABILITY_PROBE_HEADER)) {
    const cacheability = await import("./cacheability-request.js");
    const probeContext = cacheability.createWorkerCacheabilityContext(
      ctx,
      request,
      pagesRequestStagePrerenderSecret,
      adapter.responseVary,
    );
    if (probeContext !== ctx) {
      ctx = probeContext;
      finalize = cacheability.finalizeWorkerCacheabilityResponse;

      const probeUrl = new URL(request.url);
      probeUrl.searchParams.delete(VINEXT_CACHEABILITY_PROBE_QUERY_PARAM);
      request = cloneRequestWithUrl(request, probeUrl.toString());
      const headers = new Headers(request.headers);
      headers.delete(VINEXT_CACHEABILITY_PROBE_HEADER);
      request = cloneRequestWithHeaders(request, headers);
    }
  }

  const requiresCompletedResponseAdmission = adapter.requiresCompletedResponseAdmission === true;
  if (!finalize && (__cacheabilityManifest || requiresCompletedResponseAdmission)) {
    const cacheability = await import("./cacheability-request.js");
    const admissionContext = cacheability.createWorkerCacheabilityAdmissionContext(
      ctx,
      request,
      __cacheabilityManifest,
      pagesRequestStageBuildId,
      requiresCompletedResponseAdmission,
      adapter.responseVary,
    );
    if (admissionContext !== ctx) {
      ctx = admissionContext;
      finalize = cacheability.finalizeWorkerCacheabilityResponse;
    }
  }

  const response = await handleRequestStageLocally(
    request,
    env,
    ctx as PagesWorkerExecutionContext,
    (stageRequest, stageEnv, stageCtx, props) =>
      renderPagesResponse(stageRequest, stageEnv, stageCtx, props),
  );
  return finalize ? finalize(response, ctx) : response;
}

export default {
  fetch(
    request: Request,
    env?: PagesWorkerEnv,
    ctx?: PagesWorkerExecutionContext,
  ): Promise<Response> {
    return handleSingleStageRequest(request, env, ctx);
  },
};
