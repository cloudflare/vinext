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
  normalizeHost,
  proxyExternalRequest,
  requestContextFromRequest,
  sanitizeDestination,
} from "../config/config-matchers.js";
import { getHeadersContext, headersContextFromRequest } from "../shims/headers.js";
import { ensureFetchPatch, setCurrentFetchSoftTags } from "../shims/fetch-cache.js";
import { getRequestExecutionContext, type ExecutionContextLike } from "../shims/request-context.js";
import { pickRootParams, setRootParams } from "../shims/root-params.js";
import { createRequestContext, runWithRequestContext } from "../shims/unified-request-context.js";
import {
  normalizePathnameForRouteMatch,
  normalizePathnameForRouteMatchStrict,
} from "../routing/utils.js";
import { flattenErrorCauses } from "../utils/error-cause.js";
import { applyAppMiddleware } from "./app-middleware.js";
import {
  mergeMiddlewareResponseHeaders,
  type AppPageMiddlewareContext,
} from "./app-page-response.js";
import { handleAppPrerenderEndpoint } from "./app-prerender-endpoints.js";
import { normalizePath } from "./normalize-path.js";
import { normalizeMountedSlotsHeader } from "./isr-cache.js";
import { handleMetadataRouteRequest } from "./metadata-route-response.js";
import { getScriptNonceFromHeaderSources } from "./csp.js";
import {
  applyConfigHeadersToResponse,
  guardProtocolRelativeUrl,
  hasBasePath,
  normalizeTrailingSlash,
  resolvePublicFileRoute,
  stripBasePath,
  validateImageUrl,
} from "./request-pipeline.js";
import { buildPageCacheTags } from "./implicit-tags.js";
import type { MiddlewareModule } from "./middleware-runtime.js";

type AppPageParams = Record<string, string | string[]>;

type AppRscRouteMatch<TRoute> = {
  params: AppPageParams;
  route: TRoute;
};

type AppRscMiddlewareContext = AppPageMiddlewareContext & {
  requestHeaders: Headers | null;
};

type AppRscHandlerRoute = {
  page?: object | null;
  pattern: string;
  rootParamNames?: readonly string[];
  routeHandler?: object | null;
  routeSegments: readonly string[];
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

type HandleProgressiveActionRequestOptions = {
  actionId: string | null;
  cleanPathname: string;
  contentType: string;
  middlewareContext: AppRscMiddlewareContext;
  request: Request;
};

type RenderNotFoundPageOptions<TRoute> = {
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

type RequestContext = ReturnType<typeof requestContextFromRequest>;
type MetadataRoutes = Parameters<typeof handleMetadataRouteRequest>[0]["metadataRoutes"];
type MakeThenableParams = Parameters<typeof handleMetadataRouteRequest>[0]["makeThenableParams"];
type StaticParamsMap = Parameters<typeof handleAppPrerenderEndpoint>[1]["staticParamsMap"];
type RootParamNamesMap = Parameters<
  typeof handleAppPrerenderEndpoint
>[1]["rootParamNamesByPattern"];

type CreateAppRscHandlerOptions<TRoute extends AppRscHandlerRoute> = {
  basePath?: string;
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
  i18nConfig?: NextI18nConfig | null;
  loadPagesRoutes?: () => Promise<unknown>;
  makeThenableParams: MakeThenableParams;
  matchRoute: (pathname: string) => AppRscRouteMatch<TRoute> | null;
  metadataRoutes: MetadataRoutes;
  middlewareIsProxy?: boolean;
  middlewareModule?: MiddlewareModule | null;
  publicFiles: Set<string>;
  renderNotFoundPage: (options: RenderNotFoundPageOptions<TRoute>) => Promise<Response | null>;
  renderPagesFallback?: (options: RenderPagesFallbackOptions) => Promise<Response | null>;
  rootParamNamesMap?: RootParamNamesMap;
  setNavigationContext: (context: NavigationContextValue | null) => void;
  staticParamsMap: StaticParamsMap;
  trailingSlash?: boolean;
  validateDevRequestOrigin?: (request: Request) => Response | null;
};

function buildPostMiddlewareRequestContext(request: Request): RequestContext {
  const url = new URL(request.url);
  const context = getHeadersContext();
  if (!context) {
    return requestContextFromRequest(request);
  }

  return {
    headers: context.headers,
    cookies: Object.fromEntries(context.cookies),
    query: url.searchParams,
    host: normalizeHost(context.headers.get("host"), url.hostname),
  };
}

function isRedirectResponse(response: Response): boolean {
  return response.status >= 300 && response.status < 400;
}

function stripRscSuffix(pathname: string): string {
  return pathname.replace(/\.rsc$/, "");
}

function isExecutionContextLike(value: unknown): value is ExecutionContextLike {
  if (!value || typeof value !== "object") {
    return false;
  }
  return typeof Reflect.get(value, "waitUntil") === "function";
}

async function handleAppRscRequest<TRoute extends AppRscHandlerRoute>(
  options: CreateAppRscHandlerOptions<TRoute>,
  request: Request,
  requestContext: RequestContext,
): Promise<Response> {
  const handlerStart = process.env.NODE_ENV !== "production" ? performance.now() : 0;
  const url = new URL(request.url);

  if (process.env.NODE_ENV !== "production") {
    const originBlock = options.validateDevRequestOrigin?.(request);
    if (originBlock) {
      return originBlock;
    }
  }

  const protocolGuard = guardProtocolRelativeUrl(url.pathname);
  if (protocolGuard) {
    return protocolGuard;
  }

  let decodedUrlPathname: string;
  try {
    decodedUrlPathname = normalizePathnameForRouteMatchStrict(url.pathname);
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  let pathname = normalizePath(decodedUrlPathname);
  const basePath = options.basePath ?? "";
  if (basePath) {
    if (!hasBasePath(pathname, basePath) && !pathname.startsWith("/__vinext/")) {
      return new Response("Not Found", { status: 404 });
    }
    pathname = stripBasePath(pathname, basePath);
  }

  const prerenderEndpointResponse = await handleAppPrerenderEndpoint(request, {
    isPrerenderEnabled() {
      return process.env.VINEXT_PRERENDER === "1";
    },
    loadPagesRoutes: options.loadPagesRoutes,
    pathname,
    rootParamNamesByPattern: options.rootParamNamesMap,
    staticParamsMap: options.staticParamsMap,
  });
  if (prerenderEndpointResponse) {
    return prerenderEndpointResponse;
  }

  const trailingSlashRedirect = normalizeTrailingSlash(
    pathname,
    basePath,
    options.trailingSlash ?? false,
    url.search,
  );
  if (trailingSlashRedirect) {
    return trailingSlashRedirect;
  }

  if (options.configRedirects.length > 0) {
    const redirectPathname = pathname.endsWith(".rsc") ? pathname.slice(0, -4) : pathname;
    const redirect = matchRedirect(redirectPathname, options.configRedirects, requestContext);
    if (redirect) {
      const destination = sanitizeDestination(
        basePath &&
          !isExternalUrl(redirect.destination) &&
          !hasBasePath(redirect.destination, basePath)
          ? basePath + redirect.destination
          : redirect.destination,
      );
      return new Response(null, {
        status: redirect.permanent ? 308 : 307,
        headers: { Location: destination },
      });
    }
  }

  const isRscRequest = Boolean(
    pathname.endsWith(".rsc") || request.headers.get("accept")?.includes("text/x-component"),
  );
  const mountedSlotsHeader = normalizeMountedSlotsHeader(
    request.headers.get("x-vinext-mounted-slots"),
  );
  const interceptionContext =
    request.headers.get("X-Vinext-Interception-Context")?.replaceAll("\0", "") ?? null;
  let cleanPathname = stripRscSuffix(pathname);
  const middlewareContext: AppRscMiddlewareContext = {
    headers: null,
    requestHeaders: null,
    status: null,
  };

  if (options.middlewareModule) {
    const middlewareResult = await applyAppMiddleware({
      basePath,
      cleanPathname,
      context: middlewareContext,
      i18nConfig: options.i18nConfig ?? null,
      isProxy: options.middlewareIsProxy ?? false,
      module: options.middlewareModule,
      request,
    });
    if (middlewareResult.kind === "response") {
      return middlewareResult.response;
    }
    cleanPathname = middlewareResult.cleanPathname;
    if (middlewareResult.search !== null) {
      url.search = middlewareResult.search;
    }
  }

  const scriptNonce = getScriptNonceFromHeaderSources(request.headers, middlewareContext.headers);
  const postMiddlewareRequestContext = buildPostMiddlewareRequestContext(request);

  if (options.configRewrites.beforeFiles.length > 0) {
    const rewritten = matchRewrite(
      cleanPathname,
      options.configRewrites.beforeFiles,
      postMiddlewareRequestContext,
    );
    if (rewritten) {
      if (isExternalUrl(rewritten)) {
        options.clearRequestContext();
        return proxyExternalRequest(request, rewritten);
      }
      cleanPathname = rewritten;
    }
  }

  if (cleanPathname === "/_vinext/image") {
    const imageUrlResult = validateImageUrl(url.searchParams.get("url"), request.url);
    if (imageUrlResult instanceof Response) {
      return imageUrlResult;
    }
    return Response.redirect(new URL(imageUrlResult, url.origin).href, 302);
  }

  const metadataRouteResponse = await handleMetadataRouteRequest({
    metadataRoutes: options.metadataRoutes,
    cleanPathname,
    makeThenableParams: options.makeThenableParams,
  });
  if (metadataRouteResponse) {
    return metadataRouteResponse;
  }

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
  const actionContentType = request.headers.get("content-type") || "";

  const progressiveActionResponse = await options.handleProgressiveActionRequest({
    actionId,
    cleanPathname,
    contentType: actionContentType,
    middlewareContext,
    request,
  });
  if (progressiveActionResponse) {
    return progressiveActionResponse;
  }

  const serverActionResponse = await options.handleServerActionRequest({
    actionId,
    cleanPathname,
    contentType: actionContentType,
    interceptionContext,
    isRscRequest,
    middlewareContext,
    mountedSlotsHeader,
    request,
    searchParams: url.searchParams,
  });
  if (serverActionResponse) {
    return serverActionResponse;
  }

  if (options.configRewrites.afterFiles.length > 0) {
    const rewritten = matchRewrite(
      cleanPathname,
      options.configRewrites.afterFiles,
      postMiddlewareRequestContext,
    );
    if (rewritten) {
      if (isExternalUrl(rewritten)) {
        options.clearRequestContext();
        return proxyExternalRequest(request, rewritten);
      }
      cleanPathname = rewritten;
    }
  }

  let match = options.matchRoute(cleanPathname);
  if (!match && options.configRewrites.fallback.length > 0) {
    const rewritten = matchRewrite(
      cleanPathname,
      options.configRewrites.fallback,
      postMiddlewareRequestContext,
    );
    if (rewritten) {
      if (isExternalUrl(rewritten)) {
        options.clearRequestContext();
        return proxyExternalRequest(request, rewritten);
      }
      cleanPathname = rewritten;
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

    const notFoundResponse = await options.renderNotFoundPage({
      isRscRequest,
      middlewareContext,
      request,
      route: null,
      scriptNonce,
    });
    if (notFoundResponse) {
      return notFoundResponse;
    }

    options.clearRequestContext();
    const headers = new Headers();
    mergeMiddlewareResponseHeaders(headers, middlewareContext.headers);
    return new Response("Not Found", {
      status: 404,
      headers,
    });
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
    interceptionContext,
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
    if (options.ensureInstrumentation) {
      await options.ensureInstrumentation();
    }

    const executionContext = isExecutionContextLike(ctx)
      ? ctx
      : (getRequestExecutionContext() ?? null);
    const headersContext = headersContextFromRequest(request);
    const requestContext = createRequestContext({
      headersContext,
      executionContext,
      unstableCacheRevalidation: "background",
    });

    return runWithRequestContext(requestContext, async () => {
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

      if (options.configHeaders.length > 0 && !isRedirectResponse(response)) {
        const url = new URL(request.url);
        let pathname = url.pathname;
        try {
          pathname = normalizePath(normalizePathnameForRouteMatch(url.pathname));
        } catch {
          pathname = url.pathname;
        }
        const basePath = options.basePath ?? "";
        if (basePath && pathname.startsWith(basePath)) {
          pathname = pathname.slice(basePath.length) || "/";
        }
        applyConfigHeadersToResponse(response.headers, {
          configHeaders: options.configHeaders,
          pathname,
          requestContext: preMiddlewareRequestContext,
        });
      }

      return response;
    });
  };
}
