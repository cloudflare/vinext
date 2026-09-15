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
import { applyCdnResponseIdentityHeaders } from "./cache-control.js";
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
import { isOpenRedirectShaped } from "./request-pipeline.js";
import { readTrustedPrerenderStateFromHeaders } from "./prerender-route-params.js";
import { badRequestResponse, notFoundResponse } from "./http-error-responses.js";
import { assetPrefixPathname, isNextStaticPath } from "../utils/asset-prefix.js";
import { createWorkerRevalidationContext } from "./worker-revalidation-context.js";
import type { VinextAssetFetcher, VinextRequestStageContext } from "./multi-stage.js";
import {
  filterWorkerRequestStageHeaders,
  finalizeWorkerRequestStageResponse,
  prepareWorkerRequestStage,
  registerWorkerRequestStageAdapters,
} from "./worker-request-stage.js";

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

  registerWorkerRequestStageAdapters(env);
  const prepared = await prepareWorkerRequestStage(request, ctx, __prerenderSecret);
  if (prepared.response) return prepared.response;
  ({ context: ctx, request } = prepared);
  const { probeMode, probeRoute, readinessResponse } = prepared;

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
  const trustedPrerenderState = readTrustedPrerenderStateFromHeaders(
    request.headers,
    __prerenderSecret,
  );
  request = filterWorkerRequestStageHeaders(request, ctx, readinessResponse).request;

  let responseStageDispatched = false;
  const trackedDispatchResponseStage: DispatchAppWorkerResponseStage = (
    stageRequest,
    props,
    options,
  ) => {
    responseStageDispatched = true;
    return dispatchResponseStage(stageRequest, props, options);
  };

  const handle = () =>
    requestRscHandler(
      request,
      ctx,
      trackedDispatchResponseStage,
      probeMode,
      ctx.isPrerenderPathDiscovery === true,
      trustedPrerenderState,
    );
  const result = await runWithExecutionContext(ctx, handle);
  let response = result;
  if (assets) {
    const assetResponse = await resolveStaticAssetSignal(response, {
      fetchAsset: (path) => Promise.resolve(assets.fetch(createStaticAssetRequest(path, request))),
    });
    if (assetResponse) response = assetResponse;
  }
  return finalizeWorkerRequestStageResponse(
    finalizeMissingStaticAssetResponse(response, missingBuildAsset),
    probeMode,
    probeRoute,
    responseStageDispatched,
  );
}
