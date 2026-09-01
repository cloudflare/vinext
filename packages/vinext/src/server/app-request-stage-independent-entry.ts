/** Request-only App Worker stage with no local renderer fallback dependency. */

import "./server-globals.js";
import requestRscHandler, {
  __assetPrefix,
  __basePath,
  __imageAllowedWidths,
  __imageConfig,
  __prerenderSecret,
} from "virtual:vinext-app-request-entry";
import { runWithExecutionContext, type ExecutionContextLike } from "vinext/shims/request-context";
// @ts-expect-error -- virtual module resolved by vinext
import { registerConfiguredCacheAdapters } from "virtual:vinext-cache-adapters";
import { applyCdnResponseIdentityHeaders, validateCdnRequest } from "./cache-control.js";
// @ts-expect-error -- virtual module resolved by vinext
import { registerConfiguredImageOptimizer } from "virtual:vinext-image-adapters";
import type { DispatchAppWorkerResponseStage } from "./app-worker-stages.js";
import {
  getImageOptimizer,
  handleConfiguredImageOptimization,
  isImageOptimizationPath,
} from "./image-optimization.js";
import {
  createStaticAssetRequest,
  finalizeMissingStaticAssetResponse,
  resolveStaticAssetSignal,
} from "./worker-utils.js";
import {
  cloneRequestWithHeaders,
  filterInternalHeaders,
  isOpenRedirectShaped,
} from "./request-pipeline.js";
import {
  VINEXT_CACHEABILITY_PROBE_HEADER,
  VINEXT_CACHEABILITY_PROBE_QUERY_PARAM,
  VINEXT_PRERENDER_ROUTE_PARAMS_HEADER,
  VINEXT_PRERENDER_SECRET_HEADER,
  VINEXT_REVALIDATE_HOST_HEADER,
} from "./headers.js";
import {
  readTrustedPrerenderRouteParams,
  serializePrerenderRouteParamsHeader,
} from "./prerender-route-params.js";
import { badRequestResponse, notFoundResponse } from "./http-error-responses.js";
import { assetPrefixPathname, isNextStaticPath } from "../utils/asset-prefix.js";
import { createWorkerRevalidationContext } from "./worker-revalidation-context.js";
import {
  createWorkerPrerenderDiscoveryContext,
  createWorkerPrerenderReadinessResponse,
} from "./worker-prerender-discovery.js";
import type {
  VinextAssetFetcher,
  VinextCacheabilityProbeMode,
  VinextRequestStageContext,
} from "./multi-stage.js";

export type AppRequestStageEnv = Record<string, unknown>;
type AppRequestStageContext = ExecutionContextLike & VinextRequestStageContext;

const workerBasePath = typeof __basePath === "string" ? __basePath : "";
const workerAssetPathPrefix = assetPrefixPathname(
  typeof __assetPrefix === "string" ? __assetPrefix : "",
);

export function handleRequestStage(
  request: Request,
  env: AppRequestStageEnv | undefined,
  ctx: AppRequestStageContext | undefined,
  dispatchResponseStage: DispatchAppWorkerResponseStage,
): Promise<Response> {
  const originalRequest = request;
  return handleRequest(request, env, ctx, dispatchResponseStage, ctx?.assets).then((response) =>
    applyCdnResponseIdentityHeaders(response, originalRequest),
  );
}

async function handleRequest(
  request: Request,
  env: AppRequestStageEnv | undefined,
  platformCtx: ExecutionContextLike | undefined,
  dispatchResponseStage: DispatchAppWorkerResponseStage,
  assets: VinextAssetFetcher | undefined,
): Promise<Response> {
  let ctx = platformCtx?.trustedRevalidateOrigin
    ? platformCtx
    : createWorkerRevalidationContext(
        platformCtx,
        (internalRequest, internalCtx) =>
          handleRequest(internalRequest, env, internalCtx, dispatchResponseStage, assets),
        "node",
      );

  registerConfiguredCacheAdapters(env);
  registerConfiguredImageOptimizer(env);

  ctx = createWorkerPrerenderDiscoveryContext(ctx, request, __prerenderSecret);
  const readinessResponse = createWorkerPrerenderReadinessResponse(ctx, request);
  if (readinessResponse) {
    return (await validateCdnRequest(request)) ?? readinessResponse;
  }

  let probeMode: VinextCacheabilityProbeMode | null = null;
  if (request.headers.has(VINEXT_CACHEABILITY_PROBE_HEADER)) {
    const { readWorkerCacheabilityProbeMode } = await import("./cacheability-request.js");
    probeMode = readWorkerCacheabilityProbeMode(request, __prerenderSecret);
    if (probeMode) {
      const probeUrl = new URL(request.url);
      probeUrl.searchParams.delete(VINEXT_CACHEABILITY_PROBE_QUERY_PARAM);
      request = new Request(probeUrl, request);
    }
  }

  const cdnValidationResponse = await validateCdnRequest(request);
  if (cdnValidationResponse) return cdnValidationResponse;

  const url = new URL(request.url);
  if (isImageOptimizationPath(url.pathname) && assets && getImageOptimizer()) {
    return handleConfiguredImageOptimization(
      request,
      (assetPath) => Promise.resolve(assets.fetch(new Request(new URL(assetPath, request.url)))),
      __imageAllowedWidths,
      __imageConfig,
    );
  }
  if (isOpenRedirectShaped(url.pathname)) return notFoundResponse();
  try {
    decodeURIComponent(url.pathname);
  } catch {
    return badRequestResponse();
  }

  const missingBuildAsset = isNextStaticPath(url.pathname, workerBasePath, workerAssetPathPrefix);
  const trustedPrerenderRouteParams =
    ctx.hostRuntime === "node" ? readTrustedPrerenderRouteParams(request) : null;
  const filteredHeaders = ctx.isInternalPagesRevalidation
    ? new Headers(request.headers)
    : filterInternalHeaders(request.headers);
  filteredHeaders.delete(VINEXT_PRERENDER_SECRET_HEADER);
  filteredHeaders.delete(VINEXT_REVALIDATE_HOST_HEADER);
  const prerenderRouteParamsHeader = serializePrerenderRouteParamsHeader(
    trustedPrerenderRouteParams,
  );
  if (prerenderRouteParamsHeader !== null) {
    filteredHeaders.set(VINEXT_PRERENDER_ROUTE_PARAMS_HEADER, prerenderRouteParamsHeader);
  }
  request = cloneRequestWithHeaders(request, filteredHeaders);

  const handle = () =>
    requestRscHandler(
      request,
      ctx,
      dispatchResponseStage,
      probeMode,
      ctx.isPrerenderPathDiscovery === true,
    );
  const result = await runWithExecutionContext(ctx, handle);
  let response = result;
  if (assets) {
    const assetResponse = await resolveStaticAssetSignal(response, {
      fetchAsset: (path) => Promise.resolve(assets.fetch(createStaticAssetRequest(path, request))),
    });
    if (assetResponse) response = assetResponse;
  }
  return finalizeMissingStaticAssetResponse(response, missingBuildAsset);
}
