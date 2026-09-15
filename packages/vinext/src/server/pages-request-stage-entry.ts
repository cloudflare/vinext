/**
 * Request-stage entry point for vinext Pages Router.
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
  attachRequestCfMetadata,
  cloneRequestWithUrl,
  isOpenRedirectShaped,
} from "./request-pipeline.js";
import { notFoundStaticAssetResponse } from "./http-error-responses.js";
import { finalizeMissingStaticAssetResponse } from "./worker-utils.js";
import { assetPrefixPathname, isNextStaticPath } from "../utils/asset-prefix.js";
import { hasBasePath, stripBasePath } from "../utils/base-path.js";
import { createWorkerRevalidationContext } from "./worker-revalidation-context.js";
import type { ExecutionContextLike } from "vinext/shims/request-context";
import { normalizePathnameForRouteMatchStrict } from "../routing/utils.js";
import { normalizeDefaultLocalePathname } from "./pages-i18n.js";
import { requestContextFromRequest } from "../config/request-context.js";
import { resolveResponseStageCachePolicy } from "./config-headers.js";
import {
  applyCdnResponseIdentityHeaders,
  captureCdnResponsePolicyOverrides,
  reconcileCdnResponseHeadersAfterOuterPolicy,
} from "./cache-control.js";
import {
  PAGES_RESPONSE_STAGE_PROTOCOL_VERSION,
  type DispatchWorkerResponseStage,
  type WorkerResponseStageProps,
} from "./worker-stages.js";
import { getPagesResponseStageCacheDisposition } from "./pages-response-stage.js";
import type {
  VinextAssetFetcher,
  VinextRequestStageContext,
  VinextResponseStageDispatchOptions,
} from "./multi-stage.js";
import { isWorkerPrerenderDiscoveryPath } from "./worker-prerender-discovery.js";
import {
  consumePagesResponseStagePolicyOwner,
  prependResponseStageAdditiveHeaders,
  withoutResponseStageVary,
  withResponseStageVary,
} from "./response-stage-policy.js";
import {
  filterWorkerRequestStageHeaders,
  finalizeWorkerRequestStageResponse,
  prepareWorkerRequestStage,
  registerWorkerRequestStageAdapters,
} from "./worker-request-stage.js";
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

function haveSameHeaders(first: Headers, second: Headers): boolean {
  const firstEntries = [...first];
  const secondEntries = [...second];
  return (
    firstEntries.length === secondEntries.length &&
    firstEntries.every(
      ([name, value], index) =>
        name === secondEntries[index]?.[0] && value === secondEntries[index]?.[1],
    )
  );
}

function captureOuterResponsePolicyHeaders(
  stagedHeaders: Headers,
  transportedPolicyHeaders: Array<[string, string]> | null,
): Headers {
  return captureCdnResponsePolicyOverrides(
    stagedHeaders,
    new Headers(transportedPolicyHeaders ?? []),
  );
}

export type PagesLocalResponseStage = (
  request: Request,
  env: PagesWorkerEnv | undefined,
  ctx: ExecutionContextLike,
  props: WorkerResponseStageProps,
) => Promise<Response>;

const {
  authorizeOnDemandRevalidate,
  hasMiddleware,
  hasRequestAwareDocument,
  matchApiRoute,
  matchPageRoute,
  normalizeDataRequest,
  publicFiles,
  runMiddleware,
  vinextConfig,
} = pagesEntry;

export const pagesRequestStageBuildId: string | null = pagesEntry.buildId ?? null;
export const pagesRequestStagePrerenderSecret: string | null = pagesEntry.prerenderSecret ?? null;

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
  let sharedResponseHeaders: Headers | null = null;
  let sharedOuterPolicyHeaders: Headers | null = null;
  let ctx = createWorkerRevalidationContext(
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

  registerWorkerRequestStageAdapters(env);

  try {
    const prepared = await prepareWorkerRequestStage(request, ctx, pagesEntry.prerenderSecret);
    if (prepared.response) return prepared.response;
    ({ context: ctx, request } = prepared);
    const { probeMode, probeRoute, readinessResponse } = prepared;

    let responseStageDispatched = false;
    const trackedDispatchResponseStage: PagesStageRuntimeDispatch = (
      stageRequest,
      props,
      options,
      stageEnv,
      stageCtx,
    ) => {
      responseStageDispatched = true;
      return dispatchResponseStage(stageRequest, props, options, stageEnv, stageCtx);
    };

    const filtered = filterWorkerRequestStageHeaders(request, ctx, readinessResponse);
    request = filtered.request;
    const filteredHeaders = filtered.headers;

    const url = new URL(request.url);
    let pathname = url.pathname;

    if (ctx.isPrerenderPathDiscovery && isWorkerPrerenderDiscoveryPath(pathname)) {
      return trackedDispatchResponseStage(
        request,
        {
          buildId: pagesEntry.buildId,
          cacheability: {
            policyHeaders: null,
            probeMode: null,
            resolvedRoutePathname: pathname,
          },
          kind: "pages-prerender-discovery",
          protocolVersion: PAGES_RESPONSE_STAGE_PROTOCOL_VERSION,
          requestHost: url.host,
          stagedHeaders: null,
        },
        { cache: "bypass" },
        env,
        ctx,
      );
    }

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
    const responseStagePolicyPathname = i18nConfig
      ? normalizeDefaultLocalePathname(pathname, i18nConfig, { hostname: url.hostname })
      : pathname;
    const responseStagePolicyHeaders = resolveResponseStageCachePolicy({
      basePathState: { basePath, hadBasePath },
      configHeaders,
      pathname: responseStagePolicyPathname,
      requestContext: requestContextFromRequest(request),
    });
    // A known route miss is rendered speculatively before fallback rewrites or
    // the error page are selected. A remote transport may consume the request
    // body while serializing that first render, so retain the post-middleware
    // request as a replay source for every render in that retry sequence.
    // Ordinary matched page renders keep the original streaming request.
    let speculativeRenderRequest: Request | null = null;

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
      recordCacheability: forceCacheBypass,
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
        if (options?.renderErrorPageOnMiss === false && req.body !== null && !req.bodyUsed) {
          speculativeRenderRequest = req;
        }
        const stageRequest =
          speculativeRenderRequest === req && req.body !== null && !req.bodyUsed
            ? attachRequestCfMetadata(req.clone(), req)
            : req;
        const matchedPage =
          typeof matchPageRoute === "function" ? matchPageRoute(resolvedUrl, req) : null;
        const cache =
          forceCacheBypass || probeMode
            ? "bypass"
            : getPagesResponseStageCacheDisposition({
                authorizeOnDemandRevalidate:
                  typeof authorizeOnDemandRevalidate === "function"
                    ? authorizeOnDemandRevalidate
                    : undefined,
                hasRequestAwareDocument: hasRequestAwareDocument === true,
                request: req,
                requestHeadersChanged: !haveSameHeaders(filteredHeaders, req.headers),
                routeDataKind: matchedPage?.route.dataKind,
                stagedHeaders,
              });
        const isSharedStaticPage = cache === "shared" && matchedPage?.route.dataKind === "static";
        const transportedPolicyHeaders = isSharedStaticPage
          ? withoutResponseStageVary(responseStagePolicyHeaders)
          : withResponseStageVary(responseStagePolicyHeaders, stagedHeaders?.get("Vary"));
        const responseStageProps = (): WorkerResponseStageProps => ({
          buildId: pagesEntry.buildId,
          cacheability: {
            policyHeaders: transportedPolicyHeaders,
            probeMode,
            ...(isDataReq ? { representation: "pages-data" as const } : {}),
            resolvedRoutePathname: new URL(resolvedUrl, req.url).pathname,
          },
          kind: "pages-page" as const,
          protocolVersion: PAGES_RESPONSE_STAGE_PROTOCOL_VERSION,
          requestHost: new URL(req.url).host,
          renderOptions: options ?? null,
          resolvedUrl,
          // Static/ISR pages cannot observe Node's response object. Keep their
          // request-specific middleware headers outside the shared artifact so
          // one safe render can still serve every outer composition. Pages
          // request-time handlers may read res.getHeader(), so their complete
          // pre-handler snapshot is part of the shared-stage identity.
          stagedHeaders: isSharedStaticPage ? null : [...(stagedHeaders ?? new Headers())],
        });
        const isHeadRequest = req.method.toUpperCase() === "HEAD";
        const dispatched = trackedDispatchResponseStage(
          stageRequest,
          responseStageProps(),
          { cache },
          env,
          ctx,
        );
        const responsePromise = dispatched.then((response) => {
          const consumed = consumePagesResponseStagePolicyOwner(response);
          if (cache === "shared") {
            if (isSharedStaticPage && stagedHeaders) {
              prependResponseStageAdditiveHeaders(consumed.response.headers, stagedHeaders);
            }
            sharedResponseHeaders = new Headers(consumed.response.headers);
            const requestTimePolicyOwner =
              consumed.owner === "request-time" ||
              (consumed.owner === null && matchedPage?.route.dataKind === "server");
            sharedOuterPolicyHeaders = !requestTimePolicyOwner
              ? captureOuterResponsePolicyHeaders(
                  stagedHeaders ?? new Headers(),
                  transportedPolicyHeaders,
                )
              : null;
          }
          return consumed.response;
        });
        if (!isHeadRequest) return responsePromise;
        return responsePromise.then(async (response) => {
          await response.body?.cancel();
          return new Response(null, {
            headers: response.headers,
            status: response.status,
            statusText: response.statusText,
          });
        });
      },
      handleApi: (req, apiUrl, _ctx, stagedHeaders) => {
        const transportedPolicyHeaders = withResponseStageVary(
          responseStagePolicyHeaders,
          stagedHeaders.get("Vary"),
        );
        const responseStageProps = (): WorkerResponseStageProps => ({
          apiUrl,
          buildId: pagesEntry.buildId,
          cacheability: {
            policyHeaders: transportedPolicyHeaders,
            probeMode,
            resolvedRoutePathname: new URL(apiUrl, req.url).pathname,
          },
          kind: "pages-api" as const,
          protocolVersion: PAGES_RESPONSE_STAGE_PROTOCOL_VERSION,
          requestHost: new URL(req.url).host,
          stagedHeaders: [...stagedHeaders],
        });
        const cache =
          forceCacheBypass || probeMode
            ? "bypass"
            : getPagesResponseStageCacheDisposition({
                authorizeOnDemandRevalidate:
                  typeof authorizeOnDemandRevalidate === "function"
                    ? authorizeOnDemandRevalidate
                    : undefined,
                request: req,
                requestHeadersChanged: !haveSameHeaders(filteredHeaders, req.headers),
                stagedHeaders,
              });
        const dispatched = trackedDispatchResponseStage(
          req,
          responseStageProps(),
          { cache },
          env,
          ctx,
        );
        return cache === "shared"
          ? dispatched.then((response) => {
              sharedResponseHeaders = new Headers(response.headers);
              // API response headers are authored entirely by user code. The
              // ordinary merge already lets that response override config.
              sharedOuterPolicyHeaders = null;
              return response;
            })
          : dispatched;
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
      let response = finalizeMissingStaticAssetResponse(result.response, missingBuildAsset);
      if (sharedResponseHeaders && sharedOuterPolicyHeaders) {
        reconcileCdnResponseHeadersAfterOuterPolicy(response.headers, sharedOuterPolicyHeaders);
      }
      return finalizeWorkerRequestStageResponse(
        response,
        probeMode,
        probeRoute,
        responseStageDispatched,
      );
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
