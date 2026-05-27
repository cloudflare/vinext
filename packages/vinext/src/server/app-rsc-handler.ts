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
  type BasePathMatchState,
} from "../config/config-matchers.js";
import { headersContextFromRequest } from "vinext/shims/headers";
import {
  NEXT_ACTION_HEADER,
  RSC_ACTION_HEADER,
  RSC_HEADER,
  VINEXT_MW_CTX_HEADER,
} from "./headers.js";
import { ensureFetchPatch, setCurrentFetchSoftTags } from "vinext/shims/fetch-cache";
import type { ReactFormState } from "react-dom/client";
import {
  getRequestExecutionContext,
  type ExecutionContextLike,
} from "vinext/shims/request-context";
import { pickRootParams, setRootParams, type RootParams } from "vinext/shims/root-params";
import { createRequestContext, runWithRequestContext } from "vinext/shims/unified-request-context";
import { flattenErrorCauses } from "../utils/error-cause.js";
import { hasBasePath } from "../utils/base-path.js";
import { applyAppMiddleware, type AppMiddlewareContext } from "./app-middleware.js";
import { mergeMiddlewareResponseHeaders } from "./app-page-response.js";
import { handleAppPrerenderEndpoint } from "./app-prerender-endpoints.js";
import {
  createRscRedirectLocation,
  resolveInvalidRscCacheBustingRequest,
  stripRscCacheBustingSearchParam,
  stripRscSuffix,
} from "./app-rsc-cache-busting.js";
import { finalizeAppRscResponse } from "./app-rsc-response-finalizer.js";
import { normalizeRscRequest } from "./app-rsc-request-normalization.js";
import { normalizeDefaultLocalePathname } from "./pages-i18n.js";
import { notFoundResponse } from "./http-error-responses.js";
import { getScriptNonceFromHeaderSources } from "./csp.js";
import { buildPageCacheTags } from "./implicit-tags.js";
import { isImageOptimizationPath } from "./image-optimization.js";
import { handleMetadataRouteRequest } from "./metadata-route-response.js";
import type { MiddlewareModule } from "./middleware-runtime.js";
import { runWithPrerenderWorkUnit } from "./prerender-work-unit-setup.js";
import { buildPostMwRequestContext } from "./app-post-middleware-context.js";
import type { AppRscRenderMode } from "./app-rsc-render-mode.js";
import {
  cloneRequestWithHeaders,
  filterInternalHeaders,
  applyConfigHeadersToResponse,
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
  isDynamic: boolean;
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
  formState: ReactFormState | null;
  actionError?: unknown;
  actionFailed?: boolean;
  handlerStart: number;
  interceptionContext: string | null;
  isProgressiveActionRender: boolean;
  isRscRequest: boolean;
  middlewareContext: AppRscMiddlewareContext;
  mountedSlotsHeader: string | null;
  params: AppPageParams;
  rootParams?: RootParams;
  request: Request;
  route: TRoute;
  scriptNonce?: string;
  searchParams: URLSearchParams;
  renderMode: AppRscRenderMode;
};

type DispatchMatchedRouteHandlerOptions<TRoute> = {
  cleanPathname: string;
  middlewareContext: AppRscMiddlewareContext;
  /**
   * `null` for non-dynamic routes. Mirrors Next.js' route handler context
   * shape: user code that does `params ? await params : null` resolves to
   * `null` for routes without dynamic segments. Dynamic routes receive the
   * matched params object.
   */
  params: AppPageParams | null;
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

type ProgressiveActionFormStateResult =
  | {
      formState: ReactFormState | null;
      kind: "form-state";
    }
  | {
      actionError: unknown;
      actionFailed: true;
      formState: null;
      kind: "form-state";
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
  draftModeSecret: string;
  dispatchMatchedPage: (options: DispatchMatchedPageOptions<TRoute>) => Promise<Response>;
  dispatchMatchedRouteHandler: (
    options: DispatchMatchedRouteHandlerOptions<TRoute>,
  ) => Promise<Response>;
  ensureInstrumentation?: () => Promise<void>;
  handleProgressiveActionRequest: (
    options: HandleProgressiveActionRequestOptions,
  ) => Promise<Response | ProgressiveActionFormStateResult | null>;
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

// TODO(#1333): once App Router supports `basePath: false` rules (see
// `normalizeRscRequest` — it 404s out-of-basePath requests before they
// reach this code), pass `hadBasePath` here and skip the prefix when
// false, mirroring the same guard in `prod-server.ts` and `deploy.ts`.
function redirectDestinationWithBasePath(destination: string, basePath: string): string {
  if (!basePath || isExternalUrl(destination) || hasBasePath(destination, basePath)) {
    return destination;
  }
  return basePath + destination;
}

async function applyRewrite(
  options: {
    basePathState: BasePathMatchState;
    clearRequestContext: () => void;
    request: Request;
    requestContext: RequestContext;
    rewrites: NextRewrite[];
  },
  cleanPathname: string,
): Promise<Response | string | null> {
  if (!options.rewrites.length) return null;

  const rewritten = matchRewrite(
    cleanPathname,
    options.rewrites,
    options.requestContext,
    options.basePathState,
  );
  if (!rewritten) return null;

  if (isExternalUrl(rewritten)) {
    options.clearRequestContext();
    return proxyExternalRequest(options.request, rewritten);
  }

  return rewritten;
}

function applyConfigHeadersToMiddlewareRedirect(
  response: Response,
  options: {
    basePathState: BasePathMatchState;
    configHeaders: NextHeader[];
    pathname: string;
    requestContext: RequestContext;
  },
): Response {
  // Non-redirect middleware responses still pass through finalization, where
  // config headers are applied once. Redirects skip finalization to avoid
  // mutating immutable redirect headers, so they need the earlier header layer here.
  if (response.status < 300 || response.status >= 400) return response;
  if (!options.configHeaders.length) return response;

  const headers = new Headers();
  applyConfigHeadersToResponse(headers, {
    configHeaders: options.configHeaders,
    pathname: options.pathname,
    requestContext: options.requestContext,
    basePathState: options.basePathState,
  });

  if (!headers.entries().next().done) {
    mergeMiddlewareResponseHeaders(headers, response.headers);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  return response;
}

async function handleAppRscRequest<TRoute extends AppRscHandlerRoute>(
  options: CreateAppRscHandlerOptions<TRoute>,
  request: Request,
  preMiddlewareRequestContext: RequestContext,
  isDataRequest: boolean,
): Promise<Response> {
  const handlerStart = process.env.NODE_ENV !== "production" ? performance.now() : 0;

  if (process.env.NODE_ENV !== "production") {
    const originBlock = options.validateDevRequestOrigin?.(request);
    if (originBlock) return originBlock;
  }

  const normalized = normalizeRscRequest(request, options.basePath);
  if (normalized instanceof Response) return normalized;

  const { url, isRscRequest, interceptionContextHeader, mountedSlotsHeader, renderMode } =
    normalized;
  let { pathname, cleanPathname } = normalized;
  // Canonical (external) pathname the user requested. Middleware rewrites and
  // next.config.js rewrites mutate `cleanPathname` so internal route matching
  // can find the destination page, but hooks like `usePathname()` must reflect
  // the original URL the user sees in the address bar.
  // Matches Next.js: test/e2e/app-dir/hooks/hooks.test.ts —
  //   "should have the canonical url pathname on rewrite"
  const canonicalPathname = cleanPathname;

  // The request reached this point so it was either under basePath (stripped
  // by normalizeRscRequest) or basePath is empty. In both cases the matcher
  // gating below treats default (basePath: true) rules as eligible. The App
  // Router does not yet support `basePath: false` rules — they would need a
  // pre-strip hook in normalizeRscRequest to fire. Tracked as follow-up to
  // issue #1333.
  const basePathState = { basePath: options.basePath, hadBasePath: true };

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

  // Default-locale path normalisation (issue #1336, item 4). Next.js
  // splices in the (domain-aware) default locale on every request that
  // arrives without a locale prefix before running config redirect / rewrite
  // / header matching. Mirrors resolve-routes.ts lines ~250-263.
  //
  // Defined once here so the same helper is reused for the redirect match
  // below, the middleware-redirect config header match further down, and the
  // post-middleware rewrite matches. `i18nConfig` and `url.hostname` are
  // request-scoped constants from this point on.
  const matchPathname = (p: string): string =>
    normalizeDefaultLocalePathname(p, options.i18nConfig, { hostname: url.hostname });

  const redirectPathname = matchPathname(stripRscSuffix(pathname));
  const redirect = matchRedirect(
    redirectPathname,
    options.configRedirects,
    preMiddlewareRequestContext,
    basePathState,
  );
  if (redirect) {
    const destination = sanitizeDestination(
      redirectDestinationWithBasePath(redirect.destination, options.basePath),
    );
    const location =
      isRscRequest && request.headers.get(RSC_HEADER) === "1"
        ? await createRscRedirectLocation(destination, request)
        : destination;
    return new Response(null, {
      status: redirect.permanent ? 308 : 307,
      headers: { Location: location },
    });
  }

  const rscCacheBustingRedirect = await resolveInvalidRscCacheBustingRequest({
    isRscRequest,
    request,
  });
  if (rscCacheBustingRedirect) return rscCacheBustingRedirect;

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
      isDataRequest,
      isProxy: options.isMiddlewareProxy,
      module: options.middlewareModule,
      request,
      trailingSlash: options.trailingSlash,
    });
    if (middlewareResult.kind === "response") {
      return applyConfigHeadersToMiddlewareRedirect(middlewareResult.response, {
        basePathState,
        configHeaders: options.configHeaders,
        pathname: matchPathname(cleanPathname),
        requestContext: preMiddlewareRequestContext,
      });
    }

    cleanPathname = middlewareResult.cleanPathname;
    if (middlewareResult.search !== null) {
      url.search = middlewareResult.search;
    }
  }

  const scriptNonce = getScriptNonceFromHeaderSources(request.headers, middlewareContext.headers);
  const postMiddlewareRequestContext = buildPostMwRequestContext(request);

  // Rewrites (beforeFiles, afterFiles, fallback) use `matchPathname` from
  // above to splice in the default locale before matching. Route matching
  // itself continues to use the un-prefixed `cleanPathname` because App
  // Router files live under `app/...` with no locale segment. See issue
  // #1336 item 4 / pages-i18n.normalizeDefaultLocalePathname.
  const beforeFilesRewrite = await applyRewrite(
    {
      basePathState,
      clearRequestContext: options.clearRequestContext,
      request,
      requestContext: postMiddlewareRequestContext,
      rewrites: options.configRewrites.beforeFiles,
    },
    matchPathname(cleanPathname),
  );
  if (beforeFilesRewrite instanceof Response) return beforeFilesRewrite;
  if (beforeFilesRewrite) cleanPathname = beforeFilesRewrite;

  if (isImageOptimizationPath(cleanPathname)) {
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

  if (isRscRequest) {
    stripRscCacheBustingSearchParam(url);
  }

  options.setNavigationContext({
    pathname: canonicalPathname,
    searchParams: url.searchParams,
    params: {},
  });

  const actionId =
    request.headers.get(RSC_ACTION_HEADER) ?? request.headers.get(NEXT_ACTION_HEADER);
  const contentType = request.headers.get("content-type") || "";

  const progressiveActionResult = await options.handleProgressiveActionRequest({
    actionId,
    cleanPathname,
    contentType,
    middlewareContext,
    request,
  });
  if (progressiveActionResult instanceof Response) return progressiveActionResult;
  const isProgressiveActionRender = progressiveActionResult?.kind === "form-state";
  const formState = isProgressiveActionRender ? progressiveActionResult.formState : null;
  const failedProgressiveActionResult =
    isProgressiveActionRender && "actionFailed" in progressiveActionResult
      ? progressiveActionResult
      : null;
  const actionFailed = failedProgressiveActionResult !== null;
  const actionError = failedProgressiveActionResult?.actionError;

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

  let match = options.matchRoute(cleanPathname);
  if (!match || match.route.isDynamic) {
    const afterFilesRewrite = await applyRewrite(
      {
        basePathState,
        clearRequestContext: options.clearRequestContext,
        request,
        requestContext: postMiddlewareRequestContext,
        rewrites: options.configRewrites.afterFiles,
      },
      matchPathname(cleanPathname),
    );
    if (afterFilesRewrite instanceof Response) return afterFilesRewrite;
    if (afterFilesRewrite) {
      cleanPathname = afterFilesRewrite;
      match = options.matchRoute(cleanPathname);
    }
  }

  if (!match) {
    const fallbackRewrite = await applyRewrite(
      {
        basePathState,
        clearRequestContext: options.clearRequestContext,
        request,
        requestContext: postMiddlewareRequestContext,
        rewrites: options.configRewrites.fallback,
      },
      matchPathname(cleanPathname),
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

    const renderedNotFoundResponse = await options.renderNotFound({
      isRscRequest,
      middlewareContext,
      request,
      route: null,
      scriptNonce,
    });
    if (renderedNotFoundResponse) return renderedNotFoundResponse;

    options.clearRequestContext();
    const headers = new Headers();
    mergeMiddlewareResponseHeaders(headers, middlewareContext.headers);
    return notFoundResponse({ headers });
  }

  const { route, params } = match;
  options.setNavigationContext({
    pathname: canonicalPathname,
    searchParams: url.searchParams,
    params,
  });
  const rootParams = pickRootParams(params, route.rootParamNames);
  setRootParams(rootParams);

  if (route.routeHandler) {
    setCurrentFetchSoftTags(
      buildPageCacheTags(cleanPathname, [], [...route.routeSegments], "route"),
    );
    return options.dispatchMatchedRouteHandler({
      cleanPathname,
      middlewareContext,
      // Non-dynamic routes report params as `null` to match Next.js. Internal
      // bookkeeping above (navigation context, root params) keeps the matched
      // object (always `{}` for non-dynamic) so `useParams()` etc. still see
      // an object shape; only the user-facing handler context surfaces null.
      params: route.isDynamic ? params : null,
      request,
      route,
      searchParams: url.searchParams,
    });
  }

  return options.dispatchMatchedPage({
    cleanPathname,
    formState,
    actionError,
    actionFailed,
    handlerStart,
    interceptionContext: interceptionContextHeader,
    isProgressiveActionRender,
    isRscRequest,
    middlewareContext,
    mountedSlotsHeader,
    params,
    rootParams,
    request,
    route,
    scriptNonce,
    searchParams: url.searchParams,
    renderMode,
  });
}

export function createAppRscHandler<TRoute extends AppRscHandlerRoute>(
  options: CreateAppRscHandlerOptions<TRoute>,
): (request: Request, ctx: unknown) => Promise<Response> {
  return async function appRscHandler(rawRequest, ctx) {
    await options.ensureInstrumentation?.();

    // Strip forged internal headers at the App Router request boundary.
    // Must happen BEFORE headersContextFromRequest() and
    // requestContextFromRequest() so the captured context never contains
    // attacker-controlled internal headers. This is the correct boundary
    // for pure App Router requests; in hybrid app+pages mode the connect
    // handler already filtered headers upstream and x-vinext-mw-ctx
    // (not in INTERNAL_HEADERS) carries the forwarded middleware context.
    // srvx's NodeRequestHeaders reads from rawHeaders for iteration but falls
    // back to req.headers for .get() / .has(). In the dev server we add
    // x-vinext-mw-ctx to req.headers after the Request is built, so it is
    // visible to .get() but lost when filterInternalHeaders iterates. Read it
    // BEFORE iterating so applyForwardedMiddlewareContext can skip middleware.
    const mwCtx = rawRequest.headers.get(VINEXT_MW_CTX_HEADER);
    // Capture `x-nextjs-data` before filtering — the middleware redirect
    // protocol needs to know whether the inbound request was a `_next/data`
    // fetch to emit `x-nextjs-redirect` instead of an HTTP redirect.
    const isDataRequest = rawRequest.headers.get("x-nextjs-data") === "1";
    const filteredHeaders = filterInternalHeaders(rawRequest.headers);
    if (mwCtx !== null) {
      filteredHeaders.set(VINEXT_MW_CTX_HEADER, mwCtx);
    }
    const request = cloneRequestWithHeaders(rawRequest, filteredHeaders);

    const executionContext = isExecutionContextLike(ctx)
      ? ctx
      : (getRequestExecutionContext() ?? null);
    const headersContext = headersContextFromRequest(request, {
      draftModeSecret: options.draftModeSecret,
    });
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
            response = await handleAppRscRequest(
              options,
              request,
              preMiddlewareRequestContext,
              isDataRequest,
            );
          } catch (error) {
            if (process.env.NODE_ENV !== "production") {
              flattenErrorCauses(error);
            }
            throw error;
          }

          return finalizeAppRscResponse(response, request, {
            basePath: options.basePath,
            configHeaders: options.configHeaders,
            i18nConfig: options.i18nConfig,
            requestContext: preMiddlewareRequestContext,
          });
        },
        { route: () => new URL(request.url).pathname },
      ),
    );
  };
}
