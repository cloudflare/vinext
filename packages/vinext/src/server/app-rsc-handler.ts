import type {
  NextHeader,
  NextI18nConfig,
  NextRedirect,
  NextRewrite,
} from "../config/next-config.js";
import {
  isExternalUrl,
  matchRedirect,
  matchRewrite,
  proxyExternalRequest,
  requestContextFromRequest,
  sanitizeDestination,
} from "../config/config-matchers.js";
import { headersContextFromRequest } from "vinext/shims/headers";
import { ensureFetchPatch, setCurrentFetchSoftTags } from "vinext/shims/fetch-cache";
import {
  getRequestExecutionContext,
  type ExecutionContextLike,
} from "vinext/shims/request-context";
import { pickRootParams, setRootParams } from "vinext/shims/root-params";
import { createRequestContext, runWithRequestContext } from "vinext/shims/unified-request-context";
import { flattenErrorCauses } from "../utils/error-cause.js";
import { hasBasePath } from "../utils/base-path.js";
import { applyAppMiddleware, type AppMiddlewareContext } from "./app-middleware.js";
import { mergeMiddlewareResponseHeaders } from "./app-page-response.js";
import { handleAppPrerenderEndpoint } from "./app-prerender-endpoints.js";
import { finalizeAppRscResponse } from "./app-rsc-response-finalizer.js";
import { normalizeRscRequest } from "./app-rsc-request-normalization.js";
import { getScriptNonceFromHeaderSources } from "./csp.js";
import { buildPageCacheTags } from "./implicit-tags.js";
import { handleMetadataRouteRequest } from "./metadata-route-response.js";
import type { MiddlewareModule } from "./middleware-runtime.js";
import { runWithPrerenderWorkUnit } from "./prerender-work-unit-setup.js";
import { buildPostMwRequestContext } from "./app-post-middleware-context.js";
import {
  normalizeTrailingSlash,
  resolvePublicFileRoute,
  validateImageUrl,
} from "./request-pipeline.js";

type AppPageParams = Record<string, string | string[]>;
type RequestContext = ReturnType<typeof requestContextFromRequest>;
type MetadataRoutes = Parameters<typeof handleMetadataRouteRequest>[0]["metadataRoutes"];
type MakeThenableParams = Parameters<typeof handleMetadataRouteRequest>[0]["makeThenableParams"];
type StaticParamsMap = Parameters<typeof handleAppPrerenderEndpoint>[1]["staticParamsMap"];
type RootParamNamesMap = Parameters<
  typeof handleAppPrerenderEndpoint
>[1]["rootParamNamesByPattern"];

type AppRscMiddlewareContext = AppMiddlewareContext;

type AppRscHandlerRoute = {
  page?: unknown;
  pattern: string;
  rootParamNames?: readonly string[];
  routeHandler?: unknown;
  routeSegments: readonly string[];
};

type AppRscRouteMatch<TRoute> = {
  params: AppPageParams;
  route: TRoute;
};

type DispatchMatchedPageOptions<TRoute> = {
  cleanPathname: string;
  handlerStart: number;
  interceptionContext: string | null;
  isRscRequest: boolean;
  middlewareContext: AppRscMiddlewareContext;
  mountedSlotsHeader: string | null;
  params: AppPageParams;
  request: Request;
  route: TRoute;
  scriptNonce?: string;
  searchParams: URLSearchParams;
};

type DispatchMatchedRouteHandlerOptions<TRoute> = {
  cleanPathname: string;
  middlewareContext: AppRscMiddlewareContext;
  params: AppPageParams;
  request: Request;
  route: TRoute;
  searchParams: URLSearchParams;
};

type HandleProgressiveActionRequestOptions = {
  actionId: string | null;
  cleanPathname: string;
  contentType: string;
  middlewareContext: AppRscMiddlewareContext;
  request: Request;
};

type HandleServerActionRequestOptions = {
  actionId: string | null;
  cleanPathname: string;
  contentType: string;
  interceptionContext: string | null;
  isRscRequest: boolean;
  middlewareContext: AppRscMiddlewareContext;
  mountedSlotsHeader: string | null;
  request: Request;
  searchParams: URLSearchParams;
};

type RenderNotFoundOptions<TRoute> = {
  isRscRequest: boolean;
  matchedParams?: AppPageParams;
  middlewareContext: AppRscMiddlewareContext;
  request: Request;
  route: TRoute | null;
  scriptNonce?: string;
};

type RenderPagesFallbackOptions = {
  isRscRequest: boolean;
  middlewareContext: AppRscMiddlewareContext;
  request: Request;
  url: URL;
};

type NavigationContextValue = {
  params: AppPageParams;
  pathname: string;
  searchParams: URLSearchParams;
};

type CreateAppRscHandlerOptions<TRoute extends AppRscHandlerRoute> = {
  basePath: string;
  clearRequestContext: () => void;
  configHeaders: NextHeader[];
  configRedirects: NextRedirect[];
  configRewrites: {
    afterFiles: NextRewrite[];
    beforeFiles: NextRewrite[];
    fallback: NextRewrite[];
  };
  dispatchMatchedPage: (options: DispatchMatchedPageOptions<TRoute>) => Promise<Response>;
  dispatchMatchedRouteHandler: (
    options: DispatchMatchedRouteHandlerOptions<TRoute>,
  ) => Promise<Response>;
  ensureInstrumentation?: () => Promise<void>;
  handleProgressiveActionRequest: (
    options: HandleProgressiveActionRequestOptions,
  ) => Promise<Response | null>;
  handleServerActionRequest: (
    options: HandleServerActionRequestOptions,
  ) => Promise<Response | null>;
  i18nConfig: NextI18nConfig | null;
  isMiddlewareProxy: boolean;
  loadPrerenderPagesRoutes?: () => Promise<unknown>;
  makeThenableParams: MakeThenableParams;
  matchRoute: (pathname: string) => AppRscRouteMatch<TRoute> | null;
  metadataRoutes: MetadataRoutes;
  middlewareModule: MiddlewareModule | null;
  publicFiles: ReadonlySet<string>;
  renderNotFound: (options: RenderNotFoundOptions<TRoute>) => Promise<Response | null>;
  renderPagesFallback?: (options: RenderPagesFallbackOptions) => Promise<Response | null>;
  rootParamNamesByPattern?: RootParamNamesMap;
  setNavigationContext: (context: NavigationContextValue) => void;
  staticParamsMap: StaticParamsMap;
  trailingSlash: boolean;
  validateDevRequestOrigin?: (request: Request) => Response | null;
};

function hasProperty<TKey extends PropertyKey>(
  value: object,
  key: TKey,
): value is object & Record<TKey, unknown> {
  return key in value;
}

function isExecutionContextLike(value: unknown): value is ExecutionContextLike {
  if (!value || typeof value !== "object") return false;
  return hasProperty(value, "waitUntil") && typeof value.waitUntil === "function";
}

function redirectDestinationWithBasePath(destination: string, basePath: string): string {
  if (!basePath || isExternalUrl(destination) || hasBasePath(destination, basePath)) {
    return destination;
  }
  return basePath + destination;
}

async function applyRewrite(
  options: {
    clearRequestContext: () => void;
    request: Request;
    requestContext: RequestContext;
    rewrites: NextRewrite[];
  },
  cleanPathname: string,
): Promise<Response | string | null> {
  if (!options.rewrites.length) return null;

  const rewritten = matchRewrite(cleanPathname, options.rewrites, options.requestContext);
  if (!rewritten) return null;

  if (isExternalUrl(rewritten)) {
    options.clearRequestContext();
    return proxyExternalRequest(options.request, rewritten);
  }

  return rewritten;
}

async function handleAppRscRequest<TRoute extends AppRscHandlerRoute>(
  options: CreateAppRscHandlerOptions<TRoute>,
  request: Request,
  preMiddlewareRequestContext: RequestContext,
): Promise<Response> {
  const handlerStart = process.env.NODE_ENV !== "production" ? performance.now() : 0;

  if (process.env.NODE_ENV !== "production") {
    const originBlock = options.validateDevRequestOrigin?.(request);
    if (originBlock) return originBlock;
  }

  const normalized = normalizeRscRequest(request, options.basePath);
  if (normalized instanceof Response) return normalized;

  const { url, isRscRequest, interceptionContextHeader, mountedSlotsHeader } = normalized;
  let { pathname, cleanPathname } = normalized;

  const prerenderEndpointResponse = await handleAppPrerenderEndpoint(request, {
    isPrerenderEnabled() {
      return process.env.VINEXT_PRERENDER === "1";
    },
    loadPagesRoutes: options.loadPrerenderPagesRoutes,
    pathname,
    rootParamNamesByPattern: options.rootParamNamesByPattern,
    staticParamsMap: options.staticParamsMap,
  });
  if (prerenderEndpointResponse) return prerenderEndpointResponse;

  const trailingSlashRedirect = normalizeTrailingSlash(
    pathname,
    options.basePath,
    options.trailingSlash,
    url.search,
  );
  if (trailingSlashRedirect) return trailingSlashRedirect;

  const redirectPathname = pathname.endsWith(".rsc") ? pathname.slice(0, -4) : pathname;
  const redirect = matchRedirect(
    redirectPathname,
    options.configRedirects,
    preMiddlewareRequestContext,
  );
  if (redirect) {
    const destination = sanitizeDestination(
      redirectDestinationWithBasePath(redirect.destination, options.basePath),
    );
    return new Response(null, {
      status: redirect.permanent ? 308 : 307,
      headers: { Location: destination },
    });
  }

  const middlewareContext: AppRscMiddlewareContext = {
    headers: null,
    requestHeaders: null,
    status: null,
  };

  if (options.middlewareModule) {
    const middlewareResult = await applyAppMiddleware({
      basePath: options.basePath,
      cleanPathname,
      context: middlewareContext,
      i18nConfig: options.i18nConfig,
      isProxy: options.isMiddlewareProxy,
      module: options.middlewareModule,
      request,
    });
    if (middlewareResult.kind === "response") return middlewareResult.response;

    cleanPathname = middlewareResult.cleanPathname;
    if (middlewareResult.search !== null) {
      url.search = middlewareResult.search;
    }
  }

  const scriptNonce = getScriptNonceFromHeaderSources(request.headers, middlewareContext.headers);
  const postMiddlewareRequestContext = buildPostMwRequestContext(request);

  const beforeFilesRewrite = await applyRewrite(
    {
      clearRequestContext: options.clearRequestContext,
      request,
      requestContext: postMiddlewareRequestContext,
      rewrites: options.configRewrites.beforeFiles,
    },
    cleanPathname,
  );
  if (beforeFilesRewrite instanceof Response) return beforeFilesRewrite;
  if (beforeFilesRewrite) cleanPathname = beforeFilesRewrite;

  if (cleanPathname === "/_vinext/image") {
    const imageUrlResult = validateImageUrl(url.searchParams.get("url"), request.url);
    if (imageUrlResult instanceof Response) return imageUrlResult;
    return Response.redirect(new URL(imageUrlResult, url.origin).href, 302);
  }

  const metadataRouteResponse = await handleMetadataRouteRequest({
    metadataRoutes: options.metadataRoutes,
    cleanPathname,
    makeThenableParams: options.makeThenableParams,
  });
  if (metadataRouteResponse) return metadataRouteResponse;

  const publicFileResponse = resolvePublicFileRoute({
    cleanPathname,
    middlewareContext,
    pathname,
    publicFiles: options.publicFiles,
    request,
  });
  if (publicFileResponse) {
    options.clearRequestContext();
    return publicFileResponse;
  }

  options.setNavigationContext({
    pathname: cleanPathname,
    searchParams: url.searchParams,
    params: {},
  });

  const actionId = request.headers.get("x-rsc-action") ?? request.headers.get("next-action");
  const contentType = request.headers.get("content-type") || "";

  const progressiveActionResponse = await options.handleProgressiveActionRequest({
    actionId,
    cleanPathname,
    contentType,
    middlewareContext,
    request,
  });
  if (progressiveActionResponse) return progressiveActionResponse;

  const serverActionResponse = await options.handleServerActionRequest({
    actionId,
    cleanPathname,
    contentType,
    interceptionContext: interceptionContextHeader,
    isRscRequest,
    middlewareContext,
    mountedSlotsHeader,
    request,
    searchParams: url.searchParams,
  });
  if (serverActionResponse) return serverActionResponse;

  const afterFilesRewrite = await applyRewrite(
    {
      clearRequestContext: options.clearRequestContext,
      request,
      requestContext: postMiddlewareRequestContext,
      rewrites: options.configRewrites.afterFiles,
    },
    cleanPathname,
  );
  if (afterFilesRewrite instanceof Response) return afterFilesRewrite;
  if (afterFilesRewrite) cleanPathname = afterFilesRewrite;

  let match = options.matchRoute(cleanPathname);
  if (!match) {
    const fallbackRewrite = await applyRewrite(
      {
        clearRequestContext: options.clearRequestContext,
        request,
        requestContext: postMiddlewareRequestContext,
        rewrites: options.configRewrites.fallback,
      },
      cleanPathname,
    );
    if (fallbackRewrite instanceof Response) return fallbackRewrite;
    if (fallbackRewrite) {
      cleanPathname = fallbackRewrite;
      match = options.matchRoute(cleanPathname);
    }
  }

  if (!match) {
    const pagesFallbackResponse = await options.renderPagesFallback?.({
      isRscRequest,
      middlewareContext,
      request,
      url,
    });
    if (pagesFallbackResponse) {
      options.clearRequestContext();
      return pagesFallbackResponse;
    }

    const notFoundResponse = await options.renderNotFound({
      isRscRequest,
      middlewareContext,
      request,
      route: null,
      scriptNonce,
    });
    if (notFoundResponse) return notFoundResponse;

    options.clearRequestContext();
    const headers = new Headers();
    mergeMiddlewareResponseHeaders(headers, middlewareContext.headers);
    return new Response("Not Found", { status: 404, headers });
  }

  const { route, params } = match;
  options.setNavigationContext({
    pathname: cleanPathname,
    searchParams: url.searchParams,
    params,
  });
  setRootParams(pickRootParams(params, route.rootParamNames));

  if (route.routeHandler) {
    setCurrentFetchSoftTags(
      buildPageCacheTags(cleanPathname, [], [...route.routeSegments], "route"),
    );
    return options.dispatchMatchedRouteHandler({
      cleanPathname,
      middlewareContext,
      params,
      request,
      route,
      searchParams: url.searchParams,
    });
  }

  return options.dispatchMatchedPage({
    cleanPathname,
    handlerStart,
    interceptionContext: interceptionContextHeader,
    isRscRequest,
    middlewareContext,
    mountedSlotsHeader,
    params,
    request,
    route,
    scriptNonce,
    searchParams: url.searchParams,
  });
}

export function createAppRscHandler<TRoute extends AppRscHandlerRoute>(
  options: CreateAppRscHandlerOptions<TRoute>,
): (request: Request, ctx: unknown) => Promise<Response> {
  return async function appRscHandler(request, ctx) {
    await options.ensureInstrumentation?.();

    const executionContext = isExecutionContextLike(ctx)
      ? ctx
      : (getRequestExecutionContext() ?? null);
    const headersContext = headersContextFromRequest(request);
    const requestContext = createRequestContext({
      headersContext,
      executionContext,
      unstableCacheRevalidation: "background",
    });

    return runWithRequestContext(requestContext, () =>
      runWithPrerenderWorkUnit(
        async () => {
          ensureFetchPatch();
          const preMiddlewareRequestContext = requestContextFromRequest(request);
          let response: Response;

          try {
            response = await handleAppRscRequest(options, request, preMiddlewareRequestContext);
          } catch (error) {
            if (process.env.NODE_ENV !== "production") {
              flattenErrorCauses(error);
            }
            throw error;
          }

          return finalizeAppRscResponse(response, request, {
            basePath: options.basePath,
            configHeaders: options.configHeaders,
            requestContext: preMiddlewareRequestContext,
          });
        },
        { route: () => new URL(request.url).pathname },
      ),
    );
  };
}
