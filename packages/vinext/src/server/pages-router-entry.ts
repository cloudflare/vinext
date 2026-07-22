/**
 * Router-specific Cloudflare Worker entry point for vinext Pages Router.
 *
 * New projects should usually use the router-selected entry in wrangler.jsonc:
 *   "main": "vinext/server/fetch-handler"
 *
 * This Pages Router entry remains available for existing configs and for custom
 * workers that need to opt into the Pages Router handler explicitly:
 *   "main": "vinext/server/pages-router-entry"
 *
 * Or import and delegate to it from a custom worker:
 *   import handler from "vinext/server/pages-router-entry";
 *   return handler.fetch(request, env, ctx);
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

// @ts-expect-error -- virtual module resolved by vinext at build time
import { registerConfiguredCacheAdapters } from "virtual:vinext-cache-adapters";
// @ts-expect-error -- virtual module resolved by vinext at build time
import { registerConfiguredImageOptimizer } from "virtual:vinext-image-adapters";
// @ts-expect-error -- virtual module resolved by vinext at build time
import * as pagesEntry from "virtual:vinext-server-entry";

type AssetFetcher = {
  fetch(request: Request): Promise<Response> | Response;
};

type PagesWorkerEnv = {
  ASSETS?: AssetFetcher;
} & Record<string, unknown>;

type PagesWorkerExecutionContext = {
  waitUntil?(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
  cache?: unknown;
};

const {
  authorizeOnDemandRevalidate,
  handleApiRoute,
  hasMiddleware,
  matchPageRoute,
  normalizeDataRequest,
  renderPage,
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

export default {
  async fetch(
    request: Request,
    env?: PagesWorkerEnv,
    ctx?: PagesWorkerExecutionContext,
  ): Promise<Response> {
    return handleRequest(request, env, ctx);
  },
};

async function handleRequest(
  request: Request,
  env: PagesWorkerEnv | undefined,
  platformCtx: PagesWorkerExecutionContext | ExecutionContextLike | undefined,
): Promise<Response> {
  const ctx = createWorkerRevalidationContext(platformCtx, (internalRequest, internalCtx) =>
    handleRequest(internalRequest, env, internalCtx),
  );

  // Pass the Worker env so binding-backed adapters (for example KV and Images)
  // can resolve their configured bindings before request handling begins.
  registerConfiguredCacheAdapters(env);
  registerConfiguredImageOptimizer(env);

  try {
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

    const dataNorm = normalizeDataRequest(request);
    if (dataNorm.notFoundResponse) return dataNorm.notFoundResponse;
    const isDataReq = dataNorm.isDataReq;
    if (isDataReq) {
      request = dataNorm.request;
      pathname = dataNorm.normalizedPathname;
    }

    // Checked after basePath stripping so /<basePath>/_next/image works.
    if (isImageOptimizationPath(pathname) && env?.ASSETS) {
      const allowedWidths = [
        ...(vinextConfig?.images?.deviceSizes ?? DEFAULT_DEVICE_SIZES),
        ...(vinextConfig?.images?.imageSizes ?? DEFAULT_IMAGE_SIZES),
      ];
      return handleConfiguredImageOptimization(
        request,
        (assetPath) =>
          Promise.resolve(env.ASSETS!.fetch(new Request(new URL(assetPath, request.url)))),
        allowedWidths,
        imageConfig,
      );
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
      authorizeOnDemandRevalidate:
        typeof authorizeOnDemandRevalidate === "function" ? authorizeOnDemandRevalidate : undefined,
      matchPageRoute: typeof matchPageRoute === "function" ? matchPageRoute : null,
      runMiddleware:
        typeof runMiddleware === "function"
          ? wrapMiddlewareWithBasePath(runMiddleware, basePath, hadBasePath)
          : null,
      renderPage:
        typeof renderPage === "function"
          ? (req, resolvedUrl, options, stagedHeaders) =>
              renderPage(req, resolvedUrl, null, ctx, stagedHeaders, options)
          : null,
      handleApi:
        typeof handleApiRoute === "function"
          ? (req, apiUrl) => handleApiRoute(req, apiUrl, ctx, new URL(req.url).origin)
          : null,
      serveFilesystemRoute: async (requestPathname, _stagedHeaders, phase) => {
        if (!env?.ASSETS) return false;
        return fetchWorkerFilesystemRoute(request, requestPathname, phase, (assetRequest) =>
          Promise.resolve(env.ASSETS!.fetch(assetRequest)),
        );
      },
    };

    const result = await runPagesRequest(request, deps);
    if (result.type === "response") {
      return finalizeMissingStaticAssetResponse(result.response, missingBuildAsset);
    }

    // Should not reach here for a production Worker because all callbacks are
    // supplied by virtual:vinext-server-entry.
    return missingBuildAsset
      ? notFoundStaticAssetResponse()
      : new Response("This page could not be found", { status: 404 });
  } catch (error) {
    console.error("[vinext] Worker error:", error);
    return new Response("Internal Server Error", { status: 500 });
  }
}
