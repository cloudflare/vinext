/**
 * Request-stage Cloudflare Worker entry point for vinext Pages Router.
 *
 * The public pages-router-entry delegates here. Multi-stage hosts import the
 * named request handler directly and provide their response-stage dispatcher.
 */

import {
  fetchWorkerFilesystemRoute,
  runPagesRequest,
  wrapMiddlewareWithBasePath,
} from "./pages-request-pipeline.js";
import type { PagesPipelineDeps } from "./pages-request-pipeline.js";
import {
  DEFAULT_DEVICE_SIZES,
  DEFAULT_IMAGE_SIZES,
  handleConfiguredImageOptimization,
  isImageOptimizationPath,
} from "./image-optimization.js";
import type { ImageConfig } from "./image-optimization.js";
import {
  cloneRequestWithHeaders,
  cloneRequestWithUrl,
  filterInternalHeaders,
  isOpenRedirectShaped,
} from "./request-pipeline.js";
import { notFoundStaticAssetResponse } from "./http-error-responses.js";
import { finalizeMissingStaticAssetResponse } from "./worker-utils.js";
import { assetPrefixPathname, isNextStaticPath } from "../utils/asset-prefix.js";
import { hasBasePath, stripBasePath } from "../utils/base-path.js";
import { createWorkerRevalidationContext } from "./worker-revalidation-context.js";
import { VINEXT_REVALIDATE_HOST_HEADER } from "./headers.js";
import type { ExecutionContextLike } from "vinext/shims/request-context";
import { normalizePathnameForRouteMatchStrict } from "../routing/utils.js";
import { applyCdnResponseIdentityHeaders, validateCdnRequest } from "./cache-control.js";
import {
  PAGES_RESPONSE_STAGE_PROTOCOL_VERSION,
  prepareResponseStageDispatch,
  type DispatchWorkerResponseStage,
  type WorkerResponseStageProps,
} from "./worker-stages.js";
import { getPagesResponseStageCacheDisposition } from "./pages-response-stage.js";
import type {
  VinextAssetFetcher,
  VinextRequestStageContext,
  VinextResponseStageDispatchOptions,
} from "./multi-stage.js";

// @ts-expect-error -- virtual module resolved by vinext at build time
import { registerConfiguredCacheAdapters } from "virtual:vinext-cache-adapters";
// @ts-expect-error -- virtual module resolved by vinext at build time
import { registerConfiguredImageOptimizer } from "virtual:vinext-image-adapters";
// Request-only generated entry: route metadata, config, and middleware. It
// deliberately excludes page/API modules and rendering dependencies.
// @ts-expect-error -- virtual module resolved by vinext at build time
import * as pagesEntry from "virtual:vinext-pages-request-entry";

type AssetFetcher = {
  fetch(request: Request): Promise<Response> | Response;
};

export type PagesWorkerEnv = {
  ASSETS?: AssetFetcher;
} & Record<string, unknown>;

export type PagesWorkerExecutionContext = {
  waitUntil?(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
  cache?: unknown;
} & VinextRequestStageContext;

type PagesStageRuntimeDispatch = (
  request: Request,
  props: WorkerResponseStageProps,
  options: VinextResponseStageDispatchOptions,
  env: PagesWorkerEnv | undefined,
  ctx: ExecutionContextLike,
) => Promise<Response>;

export type PagesLocalResponseStage = (
  request: Request,
  env: PagesWorkerEnv | undefined,
  ctx: ExecutionContextLike,
  props: WorkerResponseStageProps,
) => Promise<Response>;

const {
  authorizeOnDemandRevalidate,
  hasMiddleware,
  matchApiRoute,
  matchPageRoute,
  normalizeDataRequest,
  publicFiles,
  runMiddleware,
  vinextConfig,
} = pagesEntry;

const basePath: string = vinextConfig?.basePath ?? "";
const assetPathPrefix: string = assetPrefixPathname(vinextConfig?.assetPrefix ?? "");
const trailingSlash: boolean = vinextConfig?.trailingSlash ?? false;
const i18nConfig = vinextConfig?.i18n ?? null;
const configRedirects = vinextConfig?.redirects ?? [];
const configRewrites = vinextConfig?.rewrites ?? {
  beforeFiles: [],
  afterFiles: [],
  fallback: [],
};
const configHeaders = vinextConfig?.headers ?? [];
const imageConfig: ImageConfig | undefined = vinextConfig?.images
  ? {
      qualities: vinextConfig.images.qualities,
      dangerouslyAllowSVG: vinextConfig.images.dangerouslyAllowSVG,
      dangerouslyAllowLocalIP: vinextConfig.images.dangerouslyAllowLocalIP,
      contentDispositionType: vinextConfig.images.contentDispositionType,
      contentSecurityPolicy: vinextConfig.images.contentSecurityPolicy,
    }
  : undefined;

/** Run the request-time stage with a host-owned response dispatcher. */
export function handleRequestStage(
  request: Request,
  env: PagesWorkerEnv | undefined,
  ctx: PagesWorkerExecutionContext | undefined,
  dispatchResponseStage: DispatchWorkerResponseStage,
): Promise<Response> {
  const originalRequest = request;
  return handleRequest(
    request,
    env,
    ctx,
    (stageRequest, props, options) => dispatchResponseStage(stageRequest, props, options),
    false,
    "node",
    ctx?.assets,
  ).then((response) => applyCdnResponseIdentityHeaders(response, originalRequest));
}

/** Preserve the direct single-entry Worker path without retaining it in request-only builds. */
export function handleRequestStageLocally(
  request: Request,
  env: PagesWorkerEnv | undefined,
  ctx: PagesWorkerExecutionContext | undefined,
  dispatchResponseStage: PagesLocalResponseStage,
): Promise<Response> {
  const originalRequest = request;
  return handleRequest(
    request,
    env,
    ctx,
    (stageRequest, props, _options, stageEnv, stageCtx) =>
      dispatchResponseStage(stageRequest, stageEnv, stageCtx, props),
    true,
    "worker",
    env?.ASSETS,
  ).then((response) => applyCdnResponseIdentityHeaders(response, originalRequest));
}

async function handleRequest(
  request: Request,
  env: PagesWorkerEnv | undefined,
  platformCtx: PagesWorkerExecutionContext | ExecutionContextLike | undefined,
  dispatchResponseStage: PagesStageRuntimeDispatch,
  forceCacheBypass: boolean,
  defaultHostRuntime: "node" | "worker",
  assets: VinextAssetFetcher | undefined,
): Promise<Response> {
  const ctx = createWorkerRevalidationContext(
    platformCtx,
    (internalRequest, internalCtx) =>
      handleRequest(
        internalRequest,
        env,
        internalCtx,
        dispatchResponseStage,
        forceCacheBypass,
        defaultHostRuntime,
        assets,
      ),
    defaultHostRuntime,
  );

  // Pass the Worker env so binding-backed adapters (for example KV and Images)
  // can resolve their configured bindings before request handling begins.
  registerConfiguredCacheAdapters(env);
  registerConfiguredImageOptimizer(env);

  try {
    const cdnValidationResponse = await validateCdnRequest(request);
    if (cdnValidationResponse) return cdnValidationResponse;

    const url = new URL(request.url);
    let pathname = url.pathname;

    // Block protocol-relative URL open redirects in all shapes:
    //   literal  //evil.com, /\\evil.com
    //   encoded  /%5Cevil.com, /%2F/evil.com
    // Browsers normalize backslash to forward slash, and percent-decode
    // Location headers, so encoded variants must be rejected before any
    // downstream redirect can echo them.
    if (isOpenRedirectShaped(pathname)) {
      return new Response("This page could not be found", { status: 404 });
    }
    try {
      normalizePathnameForRouteMatchStrict(pathname);
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    // Valid assets are served by Cloudflare's ASSETS binding before the worker
    // is invoked. Missing asset-shaped requests still need to reach middleware
    // so it can rewrite/respond; a final 404 is converted back below.
    const missingBuildAsset = isNextStaticPath(pathname, basePath, assetPathPrefix);

    // Strip internal headers from inbound requests so callers cannot forge
    // framework state. Request.headers is immutable in Workers.
    const filteredHeaders = ctx.isInternalPagesRevalidation
      ? new Headers(request.headers)
      : filterInternalHeaders(request.headers);
    filteredHeaders.delete(VINEXT_REVALIDATE_HOST_HEADER);
    request = cloneRequestWithHeaders(request, filteredHeaders);

    // Track basePath presence on the original request so matcher gating can
    // distinguish requests inside basePath from requests outside it.
    const hadBasePath = !basePath || hasBasePath(pathname, basePath);
    {
      const stripped = stripBasePath(pathname, basePath);
      if (stripped !== pathname) {
        const strippedUrl = new URL(request.url);
        strippedUrl.pathname = stripped;
        request = cloneRequestWithUrl(request, strippedUrl.toString());
        pathname = stripped;
      }
    }

    const middlewareRequest = request;
    const dataNorm = normalizeDataRequest(request);
    if (dataNorm.notFoundResponse && !vinextConfig?.skipProxyUrlNormalize) {
      return dataNorm.notFoundResponse;
    }
    const isDataReq = dataNorm.isDataReq;
    if (isDataReq && dataNorm.normalizedPathname) {
      request = dataNorm.request;
      pathname = dataNorm.normalizedPathname;
    }

    const deps: PagesPipelineDeps = {
      basePath,
      trailingSlash,
      i18nConfig,
      configRedirects,
      configRewrites,
      configHeaders,
      hadBasePath,
      isDataReq,
      isDataRequest: isDataReq,
      hasMiddleware,
      ctx,
      middlewareRequest:
        isDataReq && vinextConfig?.skipProxyUrlNormalize ? middlewareRequest : undefined,
      dataNotFoundResponse: vinextConfig?.skipProxyUrlNormalize ? dataNorm.notFoundResponse : null,
      authorizeOnDemandRevalidate:
        typeof authorizeOnDemandRevalidate === "function" ? authorizeOnDemandRevalidate : undefined,
      matchApiRoute: typeof matchApiRoute === "function" ? matchApiRoute : null,
      matchPageRoute: typeof matchPageRoute === "function" ? matchPageRoute : null,
      runMiddleware:
        typeof runMiddleware === "function"
          ? wrapMiddlewareWithBasePath(runMiddleware, basePath, hadBasePath)
          : null,
      renderPage: (req, resolvedUrl, options, stagedHeaders) => {
        const responseStageProps = (cache: "shared" | "bypass"): WorkerResponseStageProps => ({
          buildId: pagesEntry.buildId,
          kind: "pages-page" as const,
          protocolVersion: PAGES_RESPONSE_STAGE_PROTOCOL_VERSION,
          requestHost: new URL(req.url).host,
          renderOptions: options ?? null,
          resolvedUrl,
          stagedHeaders: cache === "bypass" ? [...(stagedHeaders ?? new Headers())] : null,
        });
        const cache = forceCacheBypass
          ? "bypass"
          : getPagesResponseStageCacheDisposition({
              authorizeOnDemandRevalidate:
                typeof authorizeOnDemandRevalidate === "function"
                  ? authorizeOnDemandRevalidate
                  : undefined,
              request: req,
              stagedHeaders,
            });
        const renderRequest = prepareResponseStageDispatch(req, cache);
        const isHeadRequest = req.method.toUpperCase() === "HEAD";
        const dispatched = dispatchResponseStage(
          renderRequest,
          responseStageProps(cache),
          { cache },
          env,
          ctx,
        );
        if (!isHeadRequest || cache === "bypass") return dispatched;
        return dispatched.then(async (response) => {
          await response.body?.cancel();
          return new Response(null, {
            headers: response.headers,
            status: response.status,
            statusText: response.statusText,
          });
        });
      },
      handleApi: (req, apiUrl, _ctx, stagedHeaders) => {
        const responseStageProps = (cache: "shared" | "bypass"): WorkerResponseStageProps => ({
          apiUrl,
          buildId: pagesEntry.buildId,
          kind: "pages-api" as const,
          protocolVersion: PAGES_RESPONSE_STAGE_PROTOCOL_VERSION,
          requestHost: new URL(req.url).host,
          stagedHeaders: cache === "bypass" ? [...stagedHeaders] : null,
        });
        const cache = forceCacheBypass
          ? "bypass"
          : getPagesResponseStageCacheDisposition({
              authorizeOnDemandRevalidate:
                typeof authorizeOnDemandRevalidate === "function"
                  ? authorizeOnDemandRevalidate
                  : undefined,
              request: req,
              stagedHeaders,
            });
        return dispatchResponseStage(req, responseStageProps(cache), { cache }, env, ctx);
      },
      serveFilesystemRoute: async (requestPathname, _stagedHeaders, phase, resolvedUrl) => {
        if (!assets) return false;
        if (isImageOptimizationPath(requestPathname)) {
          const imageUrl = new URL(resolvedUrl, request.url);
          const imageRequest = new Request(imageUrl, request);
          const allowedWidths = [
            ...(vinextConfig?.images?.deviceSizes ?? DEFAULT_DEVICE_SIZES),
            ...(vinextConfig?.images?.imageSizes ?? DEFAULT_IMAGE_SIZES),
          ];
          return handleConfiguredImageOptimization(
            imageRequest,
            (assetPath) =>
              Promise.resolve(assets.fetch(new Request(new URL(assetPath, request.url)))),
            allowedWidths,
            imageConfig,
          );
        }
        return fetchWorkerFilesystemRoute(
          request,
          requestPathname,
          phase,
          (assetRequest) => Promise.resolve(assets.fetch(assetRequest)),
          publicFiles,
          missingBuildAsset,
        );
      },
    };

    const result = await runPagesRequest(request, deps);
    if (result.type === "response") {
      return finalizeMissingStaticAssetResponse(result.response, missingBuildAsset);
    }

    // Should not reach here for a production Worker because all callbacks are
    // supplied by virtual:vinext-pages-request-entry.
    return missingBuildAsset
      ? notFoundStaticAssetResponse()
      : new Response("This page could not be found", { status: 404 });
  } catch (error) {
    console.error("[vinext] Worker error:", error);
    return new Response("Internal Server Error", { status: 500 });
  }
}
