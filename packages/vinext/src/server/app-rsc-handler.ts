import type {
  NextHeader,
  NextI18nConfig,
  NextRedirect,
  NextRewrite,
} from "../config/next-config.js";
import type { BasePathMatchState } from "../config/config-matchers.js";
import { requestContextFromRequest } from "../config/request-context.js";
import { isExternalUrl } from "../utils/external-url.js";
import { headersContextFromRequest } from "vinext/shims/headers";
import {
  ACTION_REVALIDATED_HEADER,
  NEXT_ACTION_HEADER,
  RSC_ACTION_HEADER,
  RSC_HEADER,
  VINEXT_MW_CTX_HEADER,
  VINEXT_PRERENDER_PAGES_STATIC_PATHS_PATH,
  VINEXT_PRERENDER_ROUTE_PARAMS_HEADER,
  VINEXT_PRERENDER_SECRET_HEADER,
  VINEXT_PRERENDER_SPECULATIVE_HEADER,
  VINEXT_PRERENDER_STATIC_PARAMS_PATH,
} from "./headers.js";
import { ensureFetchPatch, setCurrentFetchSoftTags } from "vinext/shims/fetch-cache";
import type { ReactFormState } from "react-dom/client";
import {
  getRequestExecutionContext,
  type ExecutionContextLike,
} from "vinext/shims/request-context";
import { pickRootParams, setRootParams, type RootParams } from "vinext/shims/root-params";
import {
  closeAfterResponse,
  closeAfterResponseWithBody,
  createRequestContext,
  runWithRequestContext,
} from "vinext/shims/unified-request-context";
import { flattenErrorCauses } from "../utils/error-cause.js";
import { addBasePathToPathname, hasBasePath, stripBasePath } from "../utils/base-path.js";
import { mergeRewriteQuery } from "../utils/query.js";
import type { AppMiddlewareContext, ApplyAppMiddlewareResult } from "./app-middleware.js";
import { mergeMiddlewareResponseHeaders } from "./app-page-response.js";
import type {
  AppPrerenderRootParamNamesMap,
  AppPrerenderStaticParamsMap,
} from "./app-prerender-endpoints.js";
import {
  createRscRedirectLocation,
  hasRscCacheBustingSearchParam,
  resolveInvalidRscCacheBustingRequest,
  stripRscCacheBustingSearchParam,
  stripRscSuffix,
  VINEXT_RSC_CACHE_BUSTING_SEARCH_PARAM,
} from "./app-rsc-cache-busting.js";
import { finalizeAppRscResponse } from "./app-rsc-response-finalizer.js";
import { normalizeRscRequest } from "./app-rsc-request-normalization.js";
import { buildNextDataNotFoundResponse, normalizePagesDataRequest } from "./pages-data-route.js";
import { normalizeDefaultLocalePathname } from "./pages-i18n.js";
import { notFoundResponse } from "./http-error-responses.js";
import { getRenderedConcreteUrlPathsForRoute } from "./pregenerated-concrete-paths.js";
import { getScriptNonceFromHeaderSources } from "./csp.js";
import { buildPageCacheTags } from "./implicit-tags.js";
import { parseNextHttpErrorDigest } from "./next-error-digest.js";
import {
  DEFAULT_DEVICE_SIZES,
  DEFAULT_IMAGE_SIZES,
  isImageOptimizationPath,
  resolveDevImageRedirect,
  type ImageConfig,
} from "./image-optimization.js";
import { runWithPrerenderWorkUnit } from "./prerender-work-unit-setup.js";
import { buildPostMwRequestContext } from "./app-post-middleware-context.js";
import type { AppRscRenderMode } from "./app-rsc-render-mode.js";
import type { AppPagePprFallbackCacheShell } from "./app-ppr-fallback-shell.js";
import type { ClientReuseManifestParseResult } from "./client-reuse-manifest.js";
import {
  cloneRequestWithHeaders,
  cloneRequestWithUrl,
  filterInternalHeaders,
  normalizeTrailingSlash,
  resolvePublicFileRoute,
} from "./request-pipeline.js";
import {
  matchPrerenderRouteParamsPayload,
  readTrustedPrerenderRouteParams,
  serializePrerenderRouteParamsHeader,
} from "./prerender-route-params.js";
import {
  createServerActionNotFoundResponse,
  getServerActionNotFoundMessage,
} from "./server-action-not-found.js";
import {
  createRouteTreePrefetchResponse,
  isRouteTreePrefetchRequest,
  type AppRouteTreePrefetchRoute,
  type PrefetchInliningConfig,
} from "./app-route-tree-prefetch.js";

type AppPageParams = Record<string, string | string[]>;
type RequestContext = ReturnType<typeof requestContextFromRequest>;
const STATIC_METADATA_CONFIG_HEADER_OVERRIDES = new Set(["cache-control"]);
const HAS_CONFIG_HEADERS = process.env.__VINEXT_HAS_CONFIG_HEADERS !== "false";
const HAS_CONFIG_REDIRECTS = process.env.__VINEXT_HAS_CONFIG_REDIRECTS !== "false";
const HAS_CONFIG_REWRITES = process.env.__VINEXT_HAS_CONFIG_REWRITES !== "false";
type StaticParamsMap = AppPrerenderStaticParamsMap;
type RootParamNamesMap = AppPrerenderRootParamNamesMap;

type AppRscMiddlewareContext = AppMiddlewareContext;

type RunAppMiddlewareOptions = {
  cleanPathname: string;
  context: AppRscMiddlewareContext;
  hadBasePath: boolean;
  isDataRequest: boolean;
  request: Request;
};

type AppRscHandlerRoute = {
  __loadPage?: unknown;
  __loadRouteHandler?: unknown;
  isDynamic: boolean;
  layouts?: readonly unknown[];
  layoutTreePositions?: readonly number[];
  params?: readonly string[];
  page?: unknown;
  pattern: string;
  rootParamNames?: readonly string[];
  routeHandler?: unknown;
  routeSegments: readonly string[];
  slots?: AppRouteTreePrefetchRoute["slots"];
};

type AppRscRouteMatch<TRoute> = {
  params: AppPageParams;
  route: TRoute;
};

function applyMiddlewareContextToResponse(
  response: Response,
  middlewareContext: AppRscMiddlewareContext,
): Response {
  if (!middlewareContext.headers && middlewareContext.status == null) {
    return response;
  }

  const headers = new Headers(response.headers);
  mergeMiddlewareResponseHeaders(headers, middlewareContext.headers);

  return new Response(response.body, {
    status: middlewareContext.status ?? response.status,
    statusText: response.statusText,
    headers,
  });
}

type DispatchMatchedPageOptions<TRoute> = {
  clientReuseManifest: ClientReuseManifestParseResult;
  cleanPathname: string;
  displayPathname: string;
  formState: ReactFormState | null;
  actionError?: unknown;
  actionFailed?: boolean;
  handlerStart: number;
  interceptionContext: string | null;
  interceptionPathname: string;
  isProgressiveActionRender: boolean;
  isRscRequest: boolean;
  middlewareContext: AppRscMiddlewareContext;
  mountedSlotsHeader: string | null;
  params: AppPageParams;
  pprFallbackCacheShells?:
    | readonly {
        fallbackParamNames: readonly string[];
        params: AppPageParams;
        pathname: string;
      }[]
    | null;
  pprFallbackShell?: {
    fallbackParamNames: readonly string[];
    routePattern: string;
  };
  renderedConcreteUrlPaths?: ReadonlySet<string>;
  skipStaticParamsValidation?: boolean;
  staticParamsValidationParams?: AppPageParams;
  rootParams?: RootParams;
  request: Request;
  renderedPathAndSearch?: string | null;
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

type HandleProgressiveActionRequestOptions<TRoute> = {
  actionId: string | null;
  cleanPathname: string;
  contentType: string;
  middlewareContext: AppRscMiddlewareContext;
  request: Request;
  routeMatch: AppRscRouteMatch<TRoute> | null;
};

/**
 * Side-effect headers captured during a progressive (no-JS) server action's
 * non-redirect execution. Forwarded onto the page render response so that
 * `cookies().set(...)` and revalidation kinds reach the browser. See
 * `app-server-action-execution.ts` and issue #1483 for the full rationale.
 */
type ProgressiveActionSideEffects = {
  pendingCookies: string[];
  draftCookie: string | null | undefined;
  /** Numeric revalidation kind: `0` (none), `1` (static+dynamic), etc. */
  revalidationKind: number;
};

type ProgressiveActionFormStateResult =
  | ({
      formState: ReactFormState | null;
      kind: "form-state";
    } & ProgressiveActionSideEffects)
  | ({
      actionError: unknown;
      actionFailed: true;
      formState: null;
      kind: "form-state";
    } & ProgressiveActionSideEffects);

type HandleServerActionRequestOptions<TRoute> = {
  actionId: string | null;
  cleanPathname: string;
  contentType: string;
  interceptionContext: string | null;
  isRscRequest: boolean;
  middlewareContext: AppRscMiddlewareContext;
  mountedSlotsHeader: string | null;
  request: Request;
  routeMatch: AppRscRouteMatch<TRoute> | null;
  routePathname: string;
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
  allowRscDocumentFallback?: boolean;
  appRouteMatch?: { route: { isDynamic: boolean; pattern: string } } | null;
  isDataRequest?: boolean;
  isRscRequest: boolean;
  matchKind?: "dynamic" | "static";
  middlewareContext: AppRscMiddlewareContext;
  pathname?: string;
  pagesDataRequest?: Request | null;
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
  buildId: string | null;
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
  /**
   * Hydrate a matched route's lazily-loaded page/route-handler modules before
   * any synchronous read of `route.page` / `route.routeHandler`. Idempotent and
   * dedup'd. Provided by the generated RSC entry; absent in older entries.
   */
  ensureRouteLoaded?: (route: TRoute) => unknown;
  ensureInstrumentation?: () => Promise<void>;
  /**
   * Register cache adapters configured via the vinext() `cache` option. Wired
   * from the generated RSC entry (which can import `virtual:vinext-cache-adapters`)
   * so config-driven cache handlers apply to App Router on EVERY runtime — the
   * Node server and dev included, not just the Cloudflare worker entry.
   */
  registerCacheAdapters: (env?: Record<string, unknown>) => void;
  handleProgressiveActionRequest?: (
    options: HandleProgressiveActionRequestOptions<TRoute>,
  ) => Promise<Response | ProgressiveActionFormStateResult | null>;
  handleMetadataRouteRequest?: (cleanPathname: string) => Promise<Response | null>;
  createPprFallbackShells?: (
    route: Pick<AppRscHandlerRoute, "params" | "pattern" | "rootParamNames">,
    params: AppPageParams,
  ) => AppPagePprFallbackCacheShell[];
  handleServerActionRequest?: (
    options: HandleServerActionRequestOptions<TRoute>,
  ) => Promise<Response | null>;
  i18nConfig: NextI18nConfig | null;
  imageConfig?: ImageConfig;
  isDev: boolean;
  loadPrerenderPagesRoutes?: () => Promise<unknown>;
  matchRoute: (pathname: string) => AppRscRouteMatch<TRoute> | null;
  matchRequestRoute?: (pathname: string) => AppRscRouteMatch<TRoute> | null;
  runMiddleware?: (options: RunAppMiddlewareOptions) => Promise<ApplyAppMiddlewareResult>;
  publicFiles: ReadonlySet<string>;
  prefetchInlining?: PrefetchInliningConfig;
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

function isEdgeRouteHandler(handler: unknown): boolean {
  if (!handler || typeof handler !== "object" || !hasProperty(handler, "runtime")) return false;
  return handler.runtime === "edge" || handler.runtime === "experimental-edge";
}

function isExecutionContextLike(value: unknown): value is ExecutionContextLike {
  if (!value || typeof value !== "object") return false;
  return hasProperty(value, "waitUntil") && typeof value.waitUntil === "function";
}

function createMissingServerActionResponse(
  options: Pick<CreateAppRscHandlerOptions<AppRscHandlerRoute>, "clearRequestContext">,
  actionId: string | null,
): Response {
  console.warn(getServerActionNotFoundMessage(actionId));
  options.clearRequestContext();
  return createServerActionNotFoundResponse();
}

function redirectDestinationWithBasePath(
  destination: string,
  basePath: string,
  hadBasePath: boolean,
): string {
  if (
    !basePath ||
    !hadBasePath ||
    isExternalUrl(destination) ||
    hasBasePath(destination, basePath)
  ) {
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
    /** Raw pathname identity used for config source matching and capture substitution. */
    paramsPathname?: string;
  },
  cleanPathname: string,
): Promise<Response | string | null> {
  if (!HAS_CONFIG_REWRITES || !options.rewrites.length) return null;

  const sourcePathname = options.paramsPathname ?? cleanPathname;
  const configMatchers = await import("../config/config-matchers.js");
  const rewritten = configMatchers.matchRewrite(
    sourcePathname,
    options.rewrites,
    options.requestContext,
    options.basePathState,
    options.paramsPathname,
  );
  if (!rewritten) return null;

  if (isExternalUrl(rewritten)) {
    options.clearRequestContext();
    return configMatchers.proxyExternalRequest(options.request, rewritten);
  }

  return rewritten;
}

function requestContextForResolvedUrl(
  requestContext: RequestContext,
  resolvedUrl: string,
  baseUrl: URL,
): RequestContext {
  return {
    cookies: requestContext.cookies,
    headers: requestContext.headers,
    host: requestContext.host,
    query: new URL(resolvedUrl, baseUrl).searchParams,
  };
}

function pathnameForResolvedUrl(resolvedUrl: string): string {
  return resolvedUrl.split("#", 1)[0].split("?", 1)[0];
}

async function applyConfigHeadersToMiddlewareRedirect(
  response: Response,
  options: {
    basePathState: BasePathMatchState;
    configHeaders: NextHeader[];
    pathname: string;
    requestContext: RequestContext;
  },
): Promise<Response> {
  // Non-redirect middleware responses still pass through finalization, where
  // config headers are applied once. Redirects skip finalization to avoid
  // mutating immutable redirect headers, so they need the earlier header layer here.
  if (response.status < 300 || response.status >= 400) return response;
  if (!HAS_CONFIG_HEADERS || !options.configHeaders.length) return response;

  const { applyConfigHeadersToResponse } = await import("./config-headers.js");
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

function requestWithoutRscCacheBustingSearchParam(request: Request): Request {
  const url = new URL(request.url);
  // `hasRscCacheBustingSearchParam` and `stripRscCacheBustingSearchParam` share
  // the same encoding-aware matcher (`isRscCacheBustingSearchPair`), so the
  // guard and the strip can never disagree on which pairs count as `_rsc`
  // (including encoded-key edge cases like `%5Frsc`). Gating on the matcher
  // rather than a before/after search comparison also avoids spuriously
  // rebuilding/normalizing requests whose only difference is degenerate empty
  // query pairs (e.g. `?a=1&&b=2`).
  if (!hasRscCacheBustingSearchParam(url)) return request;

  stripRscCacheBustingSearchParam(url);
  // Clone when a body is present so the original request stays usable, then
  // reconstruct via `cloneRequestWithUrl` rather than a bare `new Request` so
  // the Workers `cf` metadata is preserved (user middleware reads it directly)
  // and `duplex: "half"` is set for streaming bodies.
  const source = request.body ? request.clone() : request;
  return cloneRequestWithUrl(source, url.toString());
}

function requestWithoutRscSuffix(request: Request): Request {
  const url = new URL(request.url);
  const pathname = stripRscSuffix(url.pathname);
  if (pathname === url.pathname) return request;

  url.pathname = pathname;
  const source = request.body ? request.clone() : request;
  return cloneRequestWithUrl(source, url.toString());
}

async function handleAppRscRequest<TRoute extends AppRscHandlerRoute>(
  options: CreateAppRscHandlerOptions<TRoute>,
  request: Request,
  preMiddlewareRequestContext: RequestContext,
  isDataRequest: boolean,
  isMiddlewareDataRequest: boolean,
  pagesDataRequest: Request | null,
): Promise<Response> {
  const handlerStart = process.env.NODE_ENV !== "production" ? performance.now() : 0;

  if (process.env.NODE_ENV !== "production") {
    const originBlock = options.validateDevRequestOrigin?.(request);
    if (originBlock) return originBlock;
  }

  const canHandleOutsideBasePath =
    Boolean(options.runMiddleware) ||
    [
      ...options.configRedirects,
      ...options.configRewrites.beforeFiles,
      ...options.configRewrites.afterFiles,
      ...options.configRewrites.fallback,
      ...options.configHeaders,
    ].some((rule) => rule.basePath === false);
  const normalized = normalizeRscRequest(request, options.basePath, canHandleOutsideBasePath);
  if (normalized instanceof Response) return normalized;

  const {
    url,
    isRscRequest,
    interceptionContextHeader,
    mountedSlotsHeader,
    renderMode,
    clientReuseManifest,
    hadBasePath,
  } = normalized;
  const { requestCleanPathname } = normalized;
  let { pathname, cleanPathname } = normalized;
  let resolvedUrl = cleanPathname + url.search;
  const originalResolvedUrl = resolvedUrl;
  const getResolvedSearchParams = () => new URL(resolvedUrl, url).searchParams;
  // Canonical (external) pathname the user requested. Middleware rewrites and
  // next.config.js rewrites mutate `cleanPathname` so internal route matching
  // can find the destination page, but hooks like `usePathname()` must reflect
  // the original URL the user sees in the address bar.
  // Matches Next.js: test/e2e/app-dir/hooks/hooks.test.ts —
  //   "should have the canonical url pathname on rewrite"
  const canonicalPathname = cleanPathname;

  const basePathState = { basePath: options.basePath, hadBasePath };
  let cleanPathnameIsRequestPathname = true;
  const matchCleanPathname = () =>
    cleanPathnameIsRequestPathname && options.matchRequestRoute
      ? options.matchRequestRoute(requestCleanPathname)
      : options.matchRoute(cleanPathname);

  if (
    pathname === VINEXT_PRERENDER_STATIC_PARAMS_PATH ||
    pathname === VINEXT_PRERENDER_PAGES_STATIC_PATHS_PATH
  ) {
    const { handleAppPrerenderEndpoint } = await import("./app-prerender-endpoints.js");
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
  }

  const trailingSlashRedirect = normalizeTrailingSlash(
    requestCleanPathname,
    hadBasePath ? options.basePath : "",
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

  // Config sources match the request's raw encoded identity. Internal route
  // matching uses the normalized pathname separately, but decoding literal
  // source segments here would make aliases such as `/%72ewrite` match
  // `/rewrite`, unlike Next.js. Dynamic captures must likewise retain their
  // original percent-encoding for Location substitution.
  const redirectPathname = matchPathname(requestCleanPathname);
  const configMatchers =
    HAS_CONFIG_REDIRECTS && options.configRedirects.length
      ? await import("../config/config-matchers.js")
      : null;
  const redirect = configMatchers
    ? configMatchers.matchRedirect(
        redirectPathname,
        options.configRedirects,
        preMiddlewareRequestContext,
        basePathState,
      )
    : null;
  if (configMatchers && redirect) {
    const destination = configMatchers.sanitizeDestination(
      redirectDestinationWithBasePath(redirect.destination, options.basePath, hadBasePath),
    );
    // For RSC navigations `createRscRedirectLocation` recomputes the
    // cache-busting `_rsc` param onto the Location. For plain (document)
    // requests, carry the original request query onto the Location so it
    // survives the redirect, mirroring Next.js resolve-routes.ts (issue #1529).
    const location =
      isRscRequest && request.headers.get(RSC_HEADER) === "1"
        ? await createRscRedirectLocation(destination, request)
        : configMatchers.preserveRedirectDestinationQuery(destination, url.search);
    return new Response(null, {
      status: redirect.permanent ? 308 : 307,
      headers: { Location: location },
    });
  }

  const rscCacheBustingRedirect = hadBasePath
    ? await resolveInvalidRscCacheBustingRequest({ isRscRequest, request })
    : null;
  if (rscCacheBustingRedirect) return rscCacheBustingRedirect;

  // Keep cache-busting validation on the real request above, then hide the
  // internal `_rsc` transport query from userland middleware and post-middleware
  // has/missing matching. This mirrors Next.js' navigation middleware fixture.
  const normalizedUserlandRequest = requestWithoutRscSuffix(request);
  const userlandRequest = requestWithoutRscCacheBustingSearchParam(normalizedUserlandRequest);
  const middlewareContext: AppRscMiddlewareContext = {
    headers: null,
    requestHeaders: null,
    status: null,
  };
  let didMiddlewareRewrite = false;
  let didMiddlewareRewritePathname = false;

  if (options.runMiddleware) {
    const middlewareResult = await options.runMiddleware({
      cleanPathname,
      context: middlewareContext,
      hadBasePath,
      isDataRequest: isMiddlewareDataRequest,
      request: userlandRequest,
    });
    if (middlewareResult.kind === "response") {
      return applyConfigHeadersToMiddlewareRedirect(middlewareResult.response, {
        basePathState,
        configHeaders: options.configHeaders,
        pathname: matchPathname(requestCleanPathname),
        requestContext: preMiddlewareRequestContext,
      });
    }

    cleanPathname = middlewareResult.cleanPathname;
    didMiddlewareRewrite = middlewareResult.rewritten;
    // A rewrite destination is authoritative even when normalization makes it
    // textually equal to the incoming path (for example /%61dmin -> /admin).
    if (didMiddlewareRewrite || cleanPathname !== normalized.cleanPathname) {
      cleanPathnameIsRequestPathname = false;
    }
    didMiddlewareRewritePathname = cleanPathname !== normalized.cleanPathname;
    if (middlewareResult.search !== null) {
      url.search = middlewareResult.search;
    }
    resolvedUrl = cleanPathname + url.search;
  }

  const scriptNonce = getScriptNonceFromHeaderSources(request.headers, middlewareContext.headers);
  const postMiddlewareRequestContext = buildPostMwRequestContext(userlandRequest);
  let filesystemRouteEligible = hadBasePath || didMiddlewareRewrite;
  const validateClaimedOutsideBasePathRsc = async (): Promise<Response | null> => {
    if (hadBasePath || !filesystemRouteEligible) return null;
    return resolveInvalidRscCacheBustingRequest({ isRscRequest, request });
  };

  // Rewrites (beforeFiles, afterFiles, fallback) use `matchPathname` from
  // above to splice in the default locale before matching. Route matching
  // itself continues to use the un-prefixed `cleanPathname` because App
  // Router files live under `app/...` with no locale segment. See issue
  // #1336 item 4 / pages-i18n.normalizeDefaultLocalePathname.
  for (const rewrite of options.configRewrites.beforeFiles) {
    const beforeFilesRewrite = await applyRewrite(
      {
        basePathState,
        clearRequestContext: options.clearRequestContext,
        // External RSC rewrites must forward the validated `_rsc` token so the
        // destination server can validate the request without the original URL.
        request: normalizedUserlandRequest,
        requestContext: requestContextForResolvedUrl(
          postMiddlewareRequestContext,
          resolvedUrl,
          url,
        ),
        paramsPathname: matchPathname(
          cleanPathnameIsRequestPathname ? requestCleanPathname : cleanPathname,
        ),
        rewrites: [rewrite],
      },
      matchPathname(cleanPathname),
    );
    if (beforeFilesRewrite instanceof Response) return beforeFilesRewrite;
    if (beforeFilesRewrite) {
      resolvedUrl = mergeRewriteQuery(resolvedUrl, beforeFilesRewrite);
      cleanPathname = pathnameForResolvedUrl(resolvedUrl);
      cleanPathnameIsRequestPathname = false;
      filesystemRouteEligible = true;
    }
  }

  const claimedRscCacheBustingRedirect = await validateClaimedOutsideBasePathRsc();
  if (claimedRscCacheBustingRedirect) return claimedRscCacheBustingRedirect;

  const actionId =
    request.headers.get(RSC_ACTION_HEADER) ?? request.headers.get(NEXT_ACTION_HEADER);
  const isPostRequest = request.method.toUpperCase() === "POST";
  const contentType = request.headers.get("content-type") || "";
  const isProgressiveActionRequest =
    isPostRequest && !actionId && contentType.startsWith("multipart/form-data");
  let resolvedLateRewritesForAction = false;
  if (!filesystemRouteEligible && (actionId || isProgressiveActionRequest)) {
    let actionMatch: ReturnType<typeof options.matchRoute> = null;
    for (const rewrite of options.configRewrites.afterFiles) {
      const rewritten = await applyRewrite(
        {
          basePathState,
          clearRequestContext: options.clearRequestContext,
          request: normalizedUserlandRequest,
          requestContext: requestContextForResolvedUrl(
            postMiddlewareRequestContext,
            resolvedUrl,
            url,
          ),
          paramsPathname: matchPathname(
            cleanPathnameIsRequestPathname ? requestCleanPathname : cleanPathname,
          ),
          rewrites: [rewrite],
        },
        matchPathname(cleanPathname),
      );
      if (rewritten instanceof Response) return rewritten;
      if (!rewritten) continue;
      resolvedUrl = mergeRewriteQuery(resolvedUrl, rewritten);
      cleanPathname = pathnameForResolvedUrl(resolvedUrl);
      cleanPathnameIsRequestPathname = false;
      filesystemRouteEligible = true;
      actionMatch = matchCleanPathname();
      if (actionMatch) break;
    }
    if (!actionMatch) {
      for (const rewrite of options.configRewrites.fallback) {
        const rewritten = await applyRewrite(
          {
            basePathState,
            clearRequestContext: options.clearRequestContext,
            request: normalizedUserlandRequest,
            requestContext: requestContextForResolvedUrl(
              postMiddlewareRequestContext,
              resolvedUrl,
              url,
            ),
            paramsPathname: matchPathname(
              cleanPathnameIsRequestPathname ? requestCleanPathname : cleanPathname,
            ),
            rewrites: [rewrite],
          },
          matchPathname(cleanPathname),
        );
        if (rewritten instanceof Response) return rewritten;
        if (!rewritten) continue;
        resolvedUrl = mergeRewriteQuery(resolvedUrl, rewritten);
        cleanPathname = pathnameForResolvedUrl(resolvedUrl);
        cleanPathnameIsRequestPathname = false;
        filesystemRouteEligible = true;
        actionMatch = matchCleanPathname();
        if (actionMatch) break;
      }
    }
    resolvedLateRewritesForAction = filesystemRouteEligible;
  }

  const lateActionRscCacheBustingRedirect = await validateClaimedOutsideBasePathRsc();
  if (lateActionRscCacheBustingRedirect) return lateActionRscCacheBustingRedirect;

  if (filesystemRouteEligible && isImageOptimizationPath(cleanPathname)) {
    const imageRedirect = resolveDevImageRedirect(
      url,
      [
        ...(options.imageConfig?.deviceSizes ?? DEFAULT_DEVICE_SIZES),
        ...(options.imageConfig?.imageSizes ?? DEFAULT_IMAGE_SIZES),
      ],
      options.imageConfig?.qualities,
      { isDev: options.isDev },
    );
    if (!imageRedirect)
      return new Response("Invalid image optimization parameters", { status: 400 });
    return Response.redirect(new URL(imageRedirect, url.origin).href, 302);
  }

  if (filesystemRouteEligible && options.handleMetadataRouteRequest) {
    const metadataRouteResponse = await options.handleMetadataRouteRequest(cleanPathname);
    if (metadataRouteResponse && HAS_CONFIG_HEADERS && options.configHeaders.length) {
      const { applyConfigHeadersToResponse } = await import("./config-headers.js");
      applyConfigHeadersToResponse(metadataRouteResponse.headers, {
        basePathState,
        configHeaders: options.configHeaders,
        overwriteExisting: STATIC_METADATA_CONFIG_HEADER_OVERRIDES,
        pathname: matchPathname(
          cleanPathnameIsRequestPathname ? requestCleanPathname : cleanPathname,
        ),
        requestContext: preMiddlewareRequestContext,
      });
    }
    if (metadataRouteResponse) {
      return applyMiddlewareContextToResponse(metadataRouteResponse, middlewareContext);
    }
  }

  const publicFileResponse = filesystemRouteEligible
    ? resolvePublicFileRoute({
        cleanPathname,
        middlewareContext,
        pathname,
        publicFiles: options.publicFiles,
        request,
      })
    : null;
  if (publicFileResponse) {
    options.clearRequestContext();
    return publicFileResponse;
  }

  stripRscCacheBustingSearchParam(url);
  const resolved = new URL(resolvedUrl, url);
  stripRscCacheBustingSearchParam(resolved);
  resolvedUrl = resolved.pathname + resolved.search + resolved.hash;

  options.setNavigationContext({
    pathname: canonicalPathname,
    searchParams: getResolvedSearchParams(),
    params: {},
  });

  // Eagerly seed `setRootParams` from the current cleanPathname before any
  // action dispatch so that user code which reads `unstable_rootParams()`
  // inside route handlers, `"use cache"` functions, and the page rerender
  // that follows a successful server action observes the matched layout's
  // root params. Without this seeding the rootParams remain null until the
  // post-action match block below runs, which is too late for action
  // execution and route-handler dispatch (both happen earlier).
  //
  // The route is matched against the current cleanPathname here. Ordinary
  // requests may still be rewritten by the afterFiles / fallback loops below,
  // where the second `setRootParams` call replaces this value before rendering.
  // Out-of-basePath Server Actions resolve those late rewrites above so this
  // match already uses their claimed destination.
  const preActionMatch = filesystemRouteEligible ? matchCleanPathname() : null;
  if (preActionMatch) {
    setRootParams(pickRootParams(preActionMatch.params, preActionMatch.route.rootParamNames));
  }

  if (pagesDataRequest && didMiddlewareRewritePathname && preActionMatch) {
    const headers = new Headers();
    mergeMiddlewareResponseHeaders(headers, middlewareContext.headers);
    headers.set("content-type", "application/json");
    headers.set("x-nextjs-rewrite", resolvedUrl);
    options.clearRequestContext();
    return new Response("{}", { headers });
  }

  if (!filesystemRouteEligible && isPostRequest && actionId) {
    options.clearRequestContext();
    return notFoundResponse();
  }
  let progressiveActionResult: Response | ProgressiveActionFormStateResult | null = null;
  if (
    filesystemRouteEligible &&
    isPostRequest &&
    contentType.startsWith("multipart/form-data") &&
    !actionId
  ) {
    if (options.handleProgressiveActionRequest) {
      progressiveActionResult = await options.handleProgressiveActionRequest({
        actionId,
        cleanPathname,
        contentType,
        middlewareContext,
        request,
        routeMatch: preActionMatch,
      });
    } else if (preActionMatch?.route.__loadPage && !preActionMatch.route.__loadRouteHandler) {
      return createMissingServerActionResponse(options, null);
    }
  }
  if (progressiveActionResult instanceof Response) return progressiveActionResult;
  const progressiveActionFormState =
    progressiveActionResult?.kind === "form-state" ? progressiveActionResult : null;
  const isProgressiveActionRender = progressiveActionFormState !== null;
  const formState = progressiveActionFormState?.formState ?? null;
  const failedProgressiveActionResult =
    progressiveActionFormState && "actionError" in progressiveActionFormState
      ? progressiveActionFormState
      : null;
  const actionFailed = failedProgressiveActionResult !== null;
  const actionError = failedProgressiveActionResult?.actionError;
  const actionErrorDigest =
    actionError && typeof actionError === "object" && "digest" in actionError
      ? String(actionError.digest)
      : null;
  const actionHttpFallbackStatus = actionErrorDigest
    ? (parseNextHttpErrorDigest(actionErrorDigest)?.status ?? null)
    : null;
  const normalizedProgressiveActionError =
    actionHttpFallbackStatus === null || actionHttpFallbackStatus === 404
      ? actionError
      : { digest: "NEXT_NOT_FOUND" };
  if (actionFailed && middlewareContext.status === null && actionHttpFallbackStatus === null) {
    middlewareContext.status = 500;
  }

  const serverActionResponse =
    filesystemRouteEligible && isPostRequest && actionId && options.handleServerActionRequest
      ? await options.handleServerActionRequest({
          actionId,
          cleanPathname,
          contentType,
          interceptionContext: interceptionContextHeader,
          isRscRequest,
          middlewareContext,
          mountedSlotsHeader,
          request,
          routeMatch: preActionMatch,
          routePathname: cleanPathnameIsRequestPathname ? requestCleanPathname : cleanPathname,
          searchParams: getResolvedSearchParams(),
        })
      : null;
  if (serverActionResponse) return serverActionResponse;
  if (filesystemRouteEligible && isPostRequest && actionId && !options.handleServerActionRequest) {
    return createMissingServerActionResponse(options, actionId);
  }

  let match = preActionMatch;
  const renderPagesForMatchKind = async (
    matchKind: "dynamic" | "static",
  ): Promise<Response | null> => {
    if (!filesystemRouteEligible) return null;
    const response =
      match === null || match.route.isDynamic
        ? ((await options.renderPagesFallback?.({
            appRouteMatch: match ?? null,
            allowRscDocumentFallback: didMiddlewareRewritePathname,
            isDataRequest,
            isRscRequest,
            matchKind,
            middlewareContext,
            pathname: resolvedUrl,
            pagesDataRequest,
            request,
            url,
          })) ?? null)
        : null;
    if (!response || !pagesDataRequest || resolvedUrl === originalResolvedUrl) return response;

    const headers = new Headers(response.headers);
    headers.set("x-nextjs-rewrite", resolvedUrl);
    return new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  };
  const staticPagesFallbackResponse = await renderPagesForMatchKind("static");
  if (staticPagesFallbackResponse) {
    options.clearRequestContext();
    return staticPagesFallbackResponse;
  }
  if (!resolvedLateRewritesForAction && (!match || match.route.isDynamic)) {
    for (const rewrite of options.configRewrites.afterFiles) {
      const afterFilesRewrite = await applyRewrite(
        {
          basePathState,
          clearRequestContext: options.clearRequestContext,
          // External RSC rewrites must forward the validated `_rsc` token.
          request: normalizedUserlandRequest,
          requestContext: requestContextForResolvedUrl(
            postMiddlewareRequestContext,
            resolvedUrl,
            url,
          ),
          paramsPathname: matchPathname(
            cleanPathnameIsRequestPathname ? requestCleanPathname : cleanPathname,
          ),
          rewrites: [rewrite],
        },
        matchPathname(cleanPathname),
      );
      if (afterFilesRewrite instanceof Response) return afterFilesRewrite;
      if (!afterFilesRewrite) continue;
      resolvedUrl = mergeRewriteQuery(resolvedUrl, afterFilesRewrite);
      cleanPathname = pathnameForResolvedUrl(resolvedUrl);
      cleanPathnameIsRequestPathname = false;
      filesystemRouteEligible = true;
      const claimedRscCacheBustingRedirect = await validateClaimedOutsideBasePathRsc();
      if (claimedRscCacheBustingRedirect) return claimedRscCacheBustingRedirect;
      match = matchCleanPathname();
      const rewrittenStaticPagesResponse = await renderPagesForMatchKind("static");
      if (rewrittenStaticPagesResponse) {
        options.clearRequestContext();
        return rewrittenStaticPagesResponse;
      }
      const rewrittenDynamicPagesResponse = await renderPagesForMatchKind("dynamic");
      if (rewrittenDynamicPagesResponse) {
        options.clearRequestContext();
        return rewrittenDynamicPagesResponse;
      }
      if (match) break;
    }
  }

  const dynamicPagesFallbackResponse = await renderPagesForMatchKind("dynamic");
  if (dynamicPagesFallbackResponse) {
    options.clearRequestContext();
    return dynamicPagesFallbackResponse;
  }

  if (!resolvedLateRewritesForAction && !match) {
    for (const rewrite of options.configRewrites.fallback) {
      const fallbackRewrite = await applyRewrite(
        {
          basePathState,
          clearRequestContext: options.clearRequestContext,
          // External RSC rewrites must forward the validated `_rsc` token.
          request: normalizedUserlandRequest,
          requestContext: requestContextForResolvedUrl(
            postMiddlewareRequestContext,
            resolvedUrl,
            url,
          ),
          paramsPathname: matchPathname(
            cleanPathnameIsRequestPathname ? requestCleanPathname : cleanPathname,
          ),
          rewrites: [rewrite],
        },
        matchPathname(cleanPathname),
      );
      if (fallbackRewrite instanceof Response) return fallbackRewrite;
      if (!fallbackRewrite) continue;
      resolvedUrl = mergeRewriteQuery(resolvedUrl, fallbackRewrite);
      cleanPathname = pathnameForResolvedUrl(resolvedUrl);
      cleanPathnameIsRequestPathname = false;
      filesystemRouteEligible = true;
      const claimedRscCacheBustingRedirect = await validateClaimedOutsideBasePathRsc();
      if (claimedRscCacheBustingRedirect) return claimedRscCacheBustingRedirect;
      match = matchCleanPathname();
      const rewrittenStaticPagesResponse = await renderPagesForMatchKind("static");
      if (rewrittenStaticPagesResponse) {
        options.clearRequestContext();
        return rewrittenStaticPagesResponse;
      }
      const rewrittenDynamicPagesResponse = await renderPagesForMatchKind("dynamic");
      if (rewrittenDynamicPagesResponse) {
        options.clearRequestContext();
        return rewrittenDynamicPagesResponse;
      }
      if (match) break;
    }
  }

  if (!filesystemRouteEligible) {
    options.clearRequestContext();
    const headers = new Headers();
    mergeMiddlewareResponseHeaders(headers, middlewareContext.headers);
    return notFoundResponse({ headers });
  }

  if (pagesDataRequest) {
    options.clearRequestContext();
    if (
      options.runMiddleware &&
      (middlewareContext.status === null ||
        middlewareContext.status === 200 ||
        middlewareContext.status === 404)
    ) {
      const response = buildNextDataNotFoundResponse();
      const headers = new Headers(response.headers);
      headers.set("x-nextjs-matched-path", matchPathname(canonicalPathname));
      if (resolvedUrl !== originalResolvedUrl) {
        headers.set("x-nextjs-rewrite", resolvedUrl);
      }
      return new Response("{}", { status: 200, headers });
    }
    return buildNextDataNotFoundResponse();
  }

  if (!match) {
    // Dev-only favicon short-circuit: browsers auto-request /favicon.ico on
    // every page load. Don't compile/render the not-found page for it.
    // Check `canonicalPathname` (the original browser-requested URL) so a
    // middleware rewrite that lands on `/favicon.ico` still falls through to
    // the normal not-found render.
    // Matches Next.js: packages/next/src/server/lib/router-server.ts —
    // condition `parsedUrl.pathname === '/favicon.ico'`.
    if (process.env.NODE_ENV !== "production" && canonicalPathname === "/favicon.ico") {
      options.clearRequestContext();
      return new Response("", { status: 404 });
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
  // Hydrate lazy page/route-handler modules before the page-vs-handler dispatch
  // branch and any downstream synchronous module reads.
  if (options.ensureRouteLoaded) await options.ensureRouteLoaded(route);
  const resolvedSearchParams = getResolvedSearchParams();
  if (isRouteTreePrefetchRequest(request) && !route.routeHandler) {
    const response = await createRouteTreePrefetchResponse(route, {
      buildId: options.buildId,
      prefetchInlining: options.prefetchInlining,
    });
    options.clearRequestContext();
    return applyMiddlewareContextToResponse(response, middlewareContext);
  }
  const prerenderRouteParamsPayload = readTrustedPrerenderRouteParams(request);
  const prerenderRouteParamsMatch = matchPrerenderRouteParamsPayload(
    prerenderRouteParamsPayload,
    route.pattern,
    params,
  );
  const prerenderRouteParams = prerenderRouteParamsMatch?.params ?? null;
  const isPrerenderFallbackShell = prerenderRouteParamsMatch?.kind === "fallback-shell";
  const renderParams = prerenderRouteParams ?? params;
  let runtimeFallbackShells: AppPagePprFallbackCacheShell[] = [];
  if (
    options.createPprFallbackShells &&
    request.method === "GET" &&
    !isRscRequest &&
    !isPrerenderFallbackShell &&
    route.params
  ) {
    runtimeFallbackShells = options.createPprFallbackShells(
      {
        params: route.params,
        pattern: route.pattern,
        rootParamNames: route.rootParamNames,
      },
      params,
    );
  }
  options.setNavigationContext({
    pathname: canonicalPathname,
    searchParams: resolvedSearchParams,
    params: renderParams,
  });
  const rootParams = pickRootParams(renderParams, route.rootParamNames);
  setRootParams(rootParams);

  if (route.routeHandler) {
    setCurrentFetchSoftTags(
      buildPageCacheTags(cleanPathname, [], [...route.routeSegments], "route"),
    );
    // Next.js edge route handlers run through web/adapter.ts, which strips
    // internal search params from the request URL. Node route handlers only
    // strip `_rsc` from the parsed query object and rebuild request.url from
    // initURL, preserving it there even for RSC requests.
    const routeHandlerRequest = isEdgeRouteHandler(route.routeHandler)
      ? userlandRequest
      : normalizedUserlandRequest;
    const routeHandlerUrl = new URL(routeHandlerRequest.url);
    const internalRscValues = isEdgeRouteHandler(route.routeHandler)
      ? []
      : routeHandlerUrl.searchParams.getAll(VINEXT_RSC_CACHE_BUSTING_SEARCH_PARAM);
    routeHandlerUrl.search = resolvedSearchParams.toString();
    for (const internalRscValue of internalRscValues) {
      routeHandlerUrl.searchParams.append(VINEXT_RSC_CACHE_BUSTING_SEARCH_PARAM, internalRscValue);
    }
    return options.dispatchMatchedRouteHandler({
      cleanPathname,
      middlewareContext,
      // Non-dynamic routes report params as `null` to match Next.js. Internal
      // bookkeeping above (navigation context, root params) keeps the matched
      // object (always `{}` for non-dynamic) so `useParams()` etc. still see
      // an object shape; only the user-facing handler context surfaces null.
      params: route.isDynamic ? renderParams : null,
      request: new Request(routeHandlerUrl, routeHandlerRequest),
      route,
      searchParams: resolvedSearchParams,
    });
  }

  const pageResponse = await options.dispatchMatchedPage({
    clientReuseManifest,
    cleanPathname,
    displayPathname: canonicalPathname,
    formState,
    actionError: normalizedProgressiveActionError,
    actionFailed,
    handlerStart,
    interceptionContext: interceptionContextHeader,
    interceptionPathname: cleanPathnameIsRequestPathname ? requestCleanPathname : cleanPathname,
    isProgressiveActionRender,
    isRscRequest,
    middlewareContext,
    mountedSlotsHeader,
    params: renderParams,
    pprFallbackCacheShells: runtimeFallbackShells,
    pprFallbackShell: isPrerenderFallbackShell
      ? {
          fallbackParamNames: prerenderRouteParamsMatch.fallbackParamNames,
          routePattern: route.pattern,
        }
      : undefined,
    renderedConcreteUrlPaths: getRenderedConcreteUrlPathsForRoute(route.pattern),
    skipStaticParamsValidation: isPrerenderFallbackShell,
    staticParamsValidationParams:
      prerenderRouteParams === null || isPrerenderFallbackShell ? undefined : params,
    rootParams,
    request,
    renderedPathAndSearch: resolvedUrl,
    route,
    scriptNonce,
    searchParams: resolvedSearchParams,
    renderMode,
  });

  // No-JS progressive form actions write cookies via cookies().set() / draftMode()
  // *during action execution*, before the page rerender begins. Those writes only
  // exist on the request-scoped headers state; the page-render path never flushes
  // them. We attach them here so the rendered Response carries the action's
  // Set-Cookie headers and revalidation marker, mirroring Next.js'
  // res.setHeader('set-cookie', ...) flush in action-handler.ts / app-render.tsx.
  // Issue: https://github.com/cloudflare/vinext/issues/1483
  if (isProgressiveActionRender) {
    return applyProgressiveActionSideEffects(pageResponse, progressiveActionFormState);
  }
  return pageResponse;
}

/**
 * Append `Set-Cookie` headers and the `x-action-revalidated` marker captured
 * during progressive (no-JS) server action execution to the page render
 * response. See issue #1483.
 *
 * Falls back to rebuilding the response when the headers object is immutable
 * (e.g. `Response.redirect()`), so cookies set by the action ride out on a
 * redirect issued during the rerender too.
 */
function applyProgressiveActionSideEffects(
  response: Response,
  sideEffects: ProgressiveActionFormStateResult,
): Response {
  const hasPendingCookies = sideEffects.pendingCookies.length > 0;
  const hasDraftCookie = Boolean(sideEffects.draftCookie);
  const hasRevalidationKind = sideEffects.revalidationKind !== 0;
  if (!hasPendingCookies && !hasDraftCookie && !hasRevalidationKind) {
    return response;
  }

  const applyTo = (headers: Headers): void => {
    for (const cookie of sideEffects.pendingCookies) {
      headers.append("Set-Cookie", cookie);
    }
    if (sideEffects.draftCookie) {
      headers.append("Set-Cookie", sideEffects.draftCookie);
    }
    if (hasRevalidationKind) {
      headers.set(ACTION_REVALIDATED_HEADER, JSON.stringify(sideEffects.revalidationKind));
    }
  };

  try {
    applyTo(response.headers);
    return response;
  } catch {
    // Headers were immutable (Response.redirect()/Response.error()) — rebuild
    // with a fresh mutable Headers seeded from the original response.
    const headers = new Headers(response.headers);
    applyTo(headers);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

export function createAppRscHandler<TRoute extends AppRscHandlerRoute>(
  options: CreateAppRscHandlerOptions<TRoute>,
): (request: Request, ctx: unknown) => Promise<Response> {
  return async function appRscHandler(rawRequest, ctx) {
    // Register config-driven cache adapters before anything touches the cache.
    // On the Cloudflare worker the entry already registered them with `env` (this
    // guarded call is a no-op); on Node/dev this is where they get wired, with no
    // bindings available.
    options.registerCacheAdapters();
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
    const pagesDataUrl = new URL(rawRequest.url);
    const pagesDataInScope =
      !options.basePath || hasBasePath(pagesDataUrl.pathname, options.basePath);
    if (pagesDataInScope) {
      pagesDataUrl.pathname = stripBasePath(pagesDataUrl.pathname, options.basePath);
    }
    const pagesDataCandidate = pagesDataInScope
      ? cloneRequestWithUrl(rawRequest, pagesDataUrl.toString())
      : null;
    const pagesDataNormalization =
      options.renderPagesFallback && pagesDataCandidate
        ? normalizePagesDataRequest(
            pagesDataCandidate,
            options.buildId,
            "",
            typeof options.runMiddleware === "function" && options.trailingSlash,
          )
        : null;
    if (pagesDataNormalization?.notFoundResponse) {
      return pagesDataNormalization.notFoundResponse;
    }
    const isPagesDataRequest = pagesDataNormalization?.isDataReq === true;
    // Read the trusted prerender route params before filtering strips the
    // route-params header (it IS in VINEXT_INTERNAL_HEADERS), then re-attach the
    // validated value below so the second read in handleAppRscRequest still sees
    // it. The secret was already verified upstream at prod-server's
    // nodeToWebRequest boundary; the surviving secret header (NOT in either
    // internal-header list) lets readTrustedPrerenderRouteParams's
    // VINEXT_PRERENDER gate pass on the reconstructed request. If the secret
    // header is ever added to VINEXT_INTERNAL_HEADERS, that second read breaks.
    const prerenderRouteParamsPayload = readTrustedPrerenderRouteParams(rawRequest);
    const isTrustedSpeculativePrerender =
      process.env.VINEXT_PRERENDER === "1" &&
      rawRequest.headers.get(VINEXT_PRERENDER_SECRET_HEADER) !== null &&
      rawRequest.headers.get(VINEXT_PRERENDER_SPECULATIVE_HEADER) === "1";
    const filteredHeaders = filterInternalHeaders(rawRequest.headers);
    if (mwCtx !== null) {
      filteredHeaders.set(VINEXT_MW_CTX_HEADER, mwCtx);
    }
    const prerenderRouteParamsHeader = serializePrerenderRouteParamsHeader(
      prerenderRouteParamsPayload,
    );
    if (prerenderRouteParamsHeader !== null) {
      filteredHeaders.set(VINEXT_PRERENDER_ROUTE_PARAMS_HEADER, prerenderRouteParamsHeader);
    }
    if (isTrustedSpeculativePrerender) {
      filteredHeaders.set(VINEXT_PRERENDER_SPECULATIVE_HEADER, "1");
    }
    let appRequest = rawRequest;
    if (pagesDataNormalization?.isDataReq) {
      const appRequestUrl = new URL(pagesDataNormalization.request.url);
      appRequestUrl.pathname = addBasePathToPathname(appRequestUrl.pathname, options.basePath);
      appRequest = cloneRequestWithUrl(pagesDataCandidate!, appRequestUrl.toString());
    }
    const request = cloneRequestWithHeaders(appRequest, filteredHeaders);
    const pagesDataRequest = pagesDataNormalization?.isDataReq
      ? cloneRequestWithHeaders(pagesDataCandidate!, filteredHeaders)
      : null;

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

    const responsePromise = runWithRequestContext(requestContext, () =>
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
              isPagesDataRequest,
              isPagesDataRequest,
              pagesDataRequest,
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
    let response: Response;
    try {
      response = await responsePromise;
    } catch (error) {
      await closeAfterResponse(requestContext);
      throw error;
    }
    return closeAfterResponseWithBody(response, requestContext);
  };
}
