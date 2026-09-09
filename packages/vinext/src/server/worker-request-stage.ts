import type { ExecutionContextLike } from "vinext/shims/request-context";
import { registerLazyDataCacheHandler } from "vinext/shims/cache-handler";
// @ts-expect-error -- virtual module resolved by vinext at build time
import * as configuredCdnCacheAdapters from "virtual:vinext-cdn-cache-adapter";
// @ts-expect-error -- virtual module resolved by vinext at build time
import { registerConfiguredImageOptimizer } from "virtual:vinext-image-adapters";
import { validateCdnRequest } from "./cache-control.js";
import type { WorkerCacheabilityProbeRoute } from "./cacheability-request.js";
import {
  VINEXT_CACHEABILITY_PROBE_HEADER,
  VINEXT_CACHEABILITY_PROBE_QUERY_PARAM,
  VINEXT_EXPECTED_WORKER_VERSION_HEADER,
  VINEXT_PRERENDER_SECRET_HEADER,
  VINEXT_REVALIDATE_HOST_HEADER,
} from "./headers.js";
import type { VinextCacheabilityProbeMode } from "./multi-stage.js";
import { cloneRequestWithHeaders, filterInternalHeaders } from "./request-pipeline.js";
import {
  createWorkerPrerenderDiscoveryContext,
  validateWorkerPrerenderReadiness,
} from "./worker-prerender-discovery.js";

export function registerWorkerRequestStageAdapters(env: Record<string, unknown> | undefined): void {
  configuredCdnCacheAdapters.registerConfiguredCacheAdapters(env);
  if (configuredCdnCacheAdapters.hasConfiguredDataCache) {
    registerLazyDataCacheHandler(async () => {
      // @ts-expect-error -- virtual module resolved by vinext at build time
      const adapters = await import("virtual:vinext-cache-adapters");
      adapters.registerConfiguredCacheAdapters(env);
    });
  }
  registerConfiguredImageOptimizer(env);
}

export async function prepareWorkerRequestStage(
  request: Request,
  context: ExecutionContextLike,
  prerenderSecret: string | null | undefined,
): Promise<{
  context: ExecutionContextLike;
  probeMode: VinextCacheabilityProbeMode | null;
  probeRoute: WorkerCacheabilityProbeRoute | null;
  readinessResponse: Response | null;
  request: Request;
  response: Response | null;
}> {
  context = createWorkerPrerenderDiscoveryContext(context, request, prerenderSecret);
  const readinessResponse = await validateWorkerPrerenderReadiness(context, request);
  if (readinessResponse && readinessResponse.status !== 204) {
    return {
      context,
      probeMode: null,
      probeRoute: null,
      readinessResponse,
      request,
      response: readinessResponse,
    };
  }

  let probeMode: VinextCacheabilityProbeMode | null = null;
  let probeRoute: WorkerCacheabilityProbeRoute | null = null;
  if (request.headers.has(VINEXT_CACHEABILITY_PROBE_HEADER)) {
    const { readWorkerCacheabilityProbeMode, readWorkerCacheabilityProbeRoute } =
      await import("./cacheability-request.js");
    probeMode = readWorkerCacheabilityProbeMode(request, prerenderSecret);
    if (probeMode) {
      probeRoute = readWorkerCacheabilityProbeRoute(request);
      const url = new URL(request.url);
      url.searchParams.delete(VINEXT_CACHEABILITY_PROBE_QUERY_PARAM);
      request = new Request(url, request);
    }
  }

  return {
    context,
    probeMode,
    probeRoute,
    readinessResponse,
    request,
    response: readinessResponse ? null : await validateCdnRequest(request),
  };
}

export function filterWorkerRequestStageHeaders(
  request: Request,
  context: ExecutionContextLike,
  readinessResponse: Response | null,
): { headers: Headers; request: Request } {
  const headers = context.isInternalPagesRevalidation
    ? new Headers(request.headers)
    : filterInternalHeaders(request.headers);
  headers.delete(VINEXT_PRERENDER_SECRET_HEADER);
  headers.delete(VINEXT_REVALIDATE_HOST_HEADER);
  if (readinessResponse?.status === 204) {
    const expectedWorkerVersion = request.headers.get(VINEXT_EXPECTED_WORKER_VERSION_HEADER);
    if (expectedWorkerVersion) {
      headers.set(VINEXT_EXPECTED_WORKER_VERSION_HEADER, expectedWorkerVersion);
    }
  }
  return { headers, request: cloneRequestWithHeaders(request, headers) };
}

export async function finalizeWorkerRequestStageResponse(
  response: Response,
  probeMode: VinextCacheabilityProbeMode | null,
  probeRoute: WorkerCacheabilityProbeRoute | null,
  responseStageDispatched: boolean,
): Promise<Response> {
  if (!probeMode || !probeRoute || responseStageDispatched) return response;
  const { finalizeRequestStageCacheabilityProbe } = await import("./cacheability-request.js");
  return finalizeRequestStageCacheabilityProbe(response, {
    mode: probeMode,
    responseStageDispatched,
    route: probeRoute,
  });
}
