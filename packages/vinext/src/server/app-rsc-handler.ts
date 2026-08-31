import type {
  NextHeader,
  NextI18nConfig,
  NextRedirect,
  NextRewrite,
} from "../config/next-config.js";
import type { BasePathMatchState } from "../config/config-matchers.js";
import { requestContextFromRequest } from "../config/request-context.js";
import { normalizePathnameForRouteMatchStrict } from "../routing/utils.js";
import { isExternalUrl } from "../utils/external-url.js";
import {
  getHeadersContext,
  headersContextFromRequest,
  runWithHeadersContext,
} from "vinext/shims/headers";
import {
  ACTION_REVALIDATED_HEADER,
  FLIGHT_HEADERS,
  NEXT_ACTION_HEADER,
  RSC_ACTION_HEADER,
  RSC_HEADER,
  VINEXT_MW_CTX_HEADER,
  VINEXT_PRERENDER_PAGES_STATIC_PATHS_PATH,
  VINEXT_PRERENDER_METADATA_ROUTES_PATH,
  VINEXT_PRERENDER_ROUTE_PARAMS_HEADER,
  VINEXT_PRERENDER_SECRET_HEADER,
  VINEXT_PRERENDER_SPECULATIVE_HEADER,
  VINEXT_PRERENDER_STATIC_PARAMS_PATH,
  VINEXT_REVALIDATE_HOST_HEADER,
  VINEXT_INTERCEPTION_CONTEXT_HEADER,
  VINEXT_INTERCEPTION_ID_HEADER,
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
  preserveFullyBufferedBodyMetadata,
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
import { applyAppRscConfigHeaders, finalizeAppRscResponse } from "./app-rsc-response-finalizer.js";
import { normalizeRscRequest } from "./app-rsc-request-normalization.js";
import { buildNextDataNotFoundResponse, normalizePagesDataRequest } from "./pages-data-route.js";
import { normalizeDefaultLocalePathname } from "./pages-i18n.js";
import { badRequestResponse, notFoundResponse } from "./http-error-responses.js";
import { isOnDemandRevalidateRequest, PRERENDER_REVALIDATE_HEADER } from "./isr-cache.js";
import { isInterceptionMatchedUrlPath, normalizePath } from "./normalize-path.js";
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
import { applyCdnResponseHeaders, NEVER_CACHE_CONTROL } from "./cache-control.js";
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

function haveSameRequestCookies(
  first: ReadonlyMap<string, string>,
  second: ReadonlyMap<string, string>,
): boolean {
  if (first.size !== second.size) return false;
  for (const [name, value] of first) {
    if (second.get(name) !== value) return false;
  }
  return true;
}

function haveSamePageParams(first: AppPageParams, second: AppPageParams): boolean {
  const firstKeys = Object.keys(first);
  const secondKeys = Object.keys(second);
  if (firstKeys.length !== secondKeys.length) return false;
  for (const key of firstKeys) {
    const firstValue = first[key];
    const secondValue = second[key];
    if (Array.isArray(firstValue)) {
      if (
        !Array.isArray(secondValue) ||
        firstValue.length !== secondValue.length ||
        firstValue.some((value, index) => value !== secondValue[index])
      ) {
        return false;
      }
    } else if (firstValue !== secondValue) {
      return false;
    }
  }
  return true;
}

function hasUrlParserDotSegment(pathname: string): boolean {
  return pathname.split("/").some((segment) => {
    const decodedDots = segment.replaceAll(/%2e/gi, ".");
    return decodedDots === "." || decodedDots === "..";
  });
}

type RunAppMiddlewareOptions = {
  cleanPathname: string;
  context: AppRscMiddlewareContext;
  externalRewriteRequest: Request;
  hadBasePath: boolean;
  isDataRequest: boolean;
  middlewareRequest?: Request;
  request: Request;
  validateExternalRewriteRequest: () => Promise<Response | null>;
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
  interceptionSourceIsConcrete?: boolean;
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

  return preserveFullyBufferedBodyMetadata(
    response,
    new Response(response.body, {
      status: middlewareContext.status ?? response.status,
      statusText: response.statusText,
      headers,
    }),
  );
}

type DispatchMatchedPageOptions<TRoute> = {
  bypassInterceptionContextCache: boolean;
  clientReuseManifest: ClientReuseManifestParseResult;
  cleanPathname: string;
  displayPathname: string;
  formState: ReactFormState | null;
  actionError?: unknown;
  actionFailed?: boolean;
  handlerStart: number;
  interceptionContext: string | null;
  interceptionId: string | null;
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
  scriptNonce?: string;
  routeMatch: AppRscRouteMatch<TRoute> | null;
  routePathname: string;
  dispatchRedirectTargetRequest: (request: Request) => Promise<Response>;
  sourceConfigHeaders: Headers | null;
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
  isMetadataRoutePath?: (cleanPathname: string) => boolean | Promise<boolean>;
  getPrerenderMetadataRoutePaths?: () => Promise<unknown>;
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
  hasInterceptionId: (interceptionId: string) => boolean;
  loadPrerenderPagesRoutes?: () => Promise<unknown>;
  matchInterceptRoute?: (
    pathname: string,
    sourcePathname: string,
    interceptionId?: string | null,
  ) => AppRscRouteMatch<TRoute> | null;
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

function isForwardedActionContext(
  value: unknown,
): value is { actionForwarded: true } & Partial<ExecutionContextLike> {
  return (
    value !== null &&
    typeof value === "object" &&
    hasProperty(value, "actionForwarded") &&
    value.actionForwarded === true
  );
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
    validateExternalRewriteRequest: () => Promise<Response | null>;
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
    const validationResponse = await options.validateExternalRewriteRequest();
    if (validationResponse) return validationResponse;
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
  // URL normalization does not create a second body consumer. Reconstructing
  // from the request shares/transfers its stream into the replacement request;
  // App middleware creates the one explicit tee when it genuinely needs an
  // isolated branch.
  return cloneRequestWithUrl(request, url.toString());
}

function requestWithoutRscSuffix(request: Request): Request {
  const url = new URL(request.url);
  const pathname = stripRscSuffix(url.pathname);
  if (pathname === url.pathname) return request;

  url.pathname = pathname;
  return cloneRequestWithUrl(request, url.toString());
}

function markUnverifiedInterceptionResponseUncacheable(response: Response): Response {
  const applyNoStore = (headers: Headers): void => {
    applyCdnResponseHeaders(headers, { cacheControl: NEVER_CACHE_CONTROL });
  };
  let markedResponse = response;
  try {
    applyNoStore(markedResponse.headers);
  } catch {
    // Response.redirect() and some middleware responses expose immutable
    // headers. Rebuild them before applying the fail-closed cache policy.
    const headers = new Headers(response.headers);
    applyNoStore(headers);
    markedResponse = new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  }
  return markedResponse;
}

async function handleAppRscRequest<TRoute extends AppRscHandlerRoute>(
  options: CreateAppRscHandlerOptions<TRoute>,
  request: Request,
  preMiddlewareRequestContext: RequestContext,
  middlewareContext: AppRscMiddlewareContext,
  isDataRequest: boolean,
  isMiddlewareDataRequest: boolean,
  pagesDataRequest: Request | null,
  dispatchInternalRequest: (request: Request) => Promise<Response>,
  allowInternalRscDocumentFallback: boolean,
  setInterceptionResponseUncacheable: (uncacheable: boolean) => void,
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
  if (normalized instanceof Response) {
    if (
      request.headers.has(VINEXT_INTERCEPTION_CONTEXT_HEADER) ||
      request.headers.has(VINEXT_INTERCEPTION_ID_HEADER)
    ) {
      setInterceptionResponseUncacheable(true);
    }
    return normalized;
  }

  const {
    url,
    isRscRequest,
    interceptionContextHeader,
    interceptionIdHeader,
    mountedSlotsHeader,
    renderMode,
    clientReuseManifest,
    hadBasePath,
  } = normalized;
  const hasRawInterceptionContext =
    isRscRequest && request.headers.has(VINEXT_INTERCEPTION_CONTEXT_HEADER);
  if (hasRawInterceptionContext) {
    // Header normalization deliberately treats malformed/oversized values as
    // absent for progressive enhancement, but the raw value still contributes
    // to the RSC URL hash. Keep those attacker-selected variants out of every
    // shared cache even when routing proceeds as a direct request.
    setInterceptionResponseUncacheable(true);
  }
  // Validate the client-supplied source pathname immediately after request
  // normalization, before redirects, middleware, rewrites, or cache-busting
  // responses can observe a structurally different identity. Keep the raw
  // header for the route matcher's deliberate one-decode contract, while
  // carrying the decoded canonical pathname for middleware authorization.
  let interceptionSourcePathname: string | null = null;
  if (isRscRequest && interceptionContextHeader !== null) {
    try {
      if (!isInterceptionMatchedUrlPath(interceptionContextHeader)) {
        throw new Error("Invalid interception source pathname");
      }
      const decodedInterceptionSourcePathname =
        normalizePathnameForRouteMatchStrict(interceptionContextHeader);
      if (/[\t\n\r]/.test(decodedInterceptionSourcePathname)) {
        throw new Error("Interception source contains a stripped URL character");
      }
      if (hasUrlParserDotSegment(decodedInterceptionSourcePathname)) {
        throw new Error("Interception source contains a URL dot segment");
      }
      interceptionSourcePathname = normalizePath(decodedInterceptionSourcePathname);
      if (interceptionSourcePathname !== decodedInterceptionSourcePathname) {
        throw new Error("Non-canonical interception source pathname");
      }
    } catch {
      options.clearRequestContext();
      setInterceptionResponseUncacheable(true);
      return badRequestResponse();
    }
  }
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
    interceptionIdHeader !== null &&
    (!isRscRequest ||
      interceptionContextHeader === null ||
      (request.method !== "GET" && request.method !== "HEAD") ||
      !options.hasInterceptionId(interceptionIdHeader))
  ) {
    // Reject attacker-selected selector values before middleware, redirects,
    // or other early responders can attach a cacheable policy. Exact
    // source/target verification still happens after rewrites below.
    setInterceptionResponseUncacheable(true);
    return badRequestResponse();
  }

  if (interceptionIdHeader !== null) {
    // Canonicalize selector-bearing URLs before any cacheable redirect can
    // depend on the selector. During rollout, a pre-selector `_rsc` hash can
    // otherwise give two graph-owned IDs the same request URL while producing
    // different redirect locations.
    const selectorCacheBustingRedirect = await resolveInvalidRscCacheBustingRequest({
      isRscRequest,
      request,
    });
    if (selectorCacheBustingRedirect) return selectorCacheBustingRedirect;
  }

  const provesConcreteInterceptionSource = (
    sourceMatch: AppRscRouteMatch<TRoute> | null,
  ): boolean => {
    if (sourceMatch === null) return false;
    if (sourceMatch.interceptionSourceIsConcrete !== undefined) {
      return sourceMatch.interceptionSourceIsConcrete;
    }
    // Backward-compatible fallback for custom/older entry glue. Route identity
    // proves existence without decoding the already-once-decoded context again
    // for a parameter comparison.
    return (
      interceptionSourcePathname !== null &&
      options.matchRoute(interceptionSourcePathname)?.route === sourceMatch.route
    );
  };
  const directInterceptionSourceMatch =
    hadBasePath && hasRawInterceptionContext && interceptionContextHeader !== null
      ? (options.matchInterceptRoute?.(
          requestCleanPathname,
          interceptionContextHeader,
          interceptionIdHeader,
        ) ?? null)
      : null;
  if (provesConcreteInterceptionSource(directInterceptionSourceMatch)) {
    // Direct targets with a concrete source can be proven before config
    // redirects or middleware. If routing later changes the target, the
    // post-rewrite proof below replaces this state before page dispatch.
    setInterceptionResponseUncacheable(false);
  }

  if (
    pathname === VINEXT_PRERENDER_STATIC_PARAMS_PATH ||
    pathname === VINEXT_PRERENDER_PAGES_STATIC_PATHS_PATH ||
    pathname === VINEXT_PRERENDER_METADATA_ROUTES_PATH
  ) {
    const { handleAppPrerenderEndpoint } = await import("./app-prerender-endpoints.js");
    const prerenderEndpointResponse = await handleAppPrerenderEndpoint(request, {
      isPrerenderEnabled() {
        return process.env.VINEXT_PRERENDER === "1";
      },
      getMetadataRoutePaths: options.getPrerenderMetadataRoutePaths,
      loadPagesRoutes: options.loadPrerenderPagesRoutes,
      pathname,
      rootParamNamesByPattern: options.rootParamNamesByPattern,
      staticParamsMap: options.staticParamsMap,
    });
    if (prerenderEndpointResponse) return prerenderEndpointResponse;
  }

  const metadataBypassesTrailingSlash =
    options.trailingSlash &&
    options.isMetadataRoutePath &&
    (await options.isMetadataRoutePath(cleanPathname));
  const trailingSlashRedirect = metadataBypassesTrailingSlash
    ? null
    : normalizeTrailingSlash(
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

  const rscCacheBustingRedirect =
    hadBasePath && interceptionIdHeader === null
      ? await resolveInvalidRscCacheBustingRequest({ isRscRequest, request })
      : null;
  if (rscCacheBustingRedirect) return rscCacheBustingRedirect;

  let filesystemRouteEligible = hadBasePath;
  const validateClaimedOutsideBasePathRsc = async (
    routeClaimed = filesystemRouteEligible,
  ): Promise<Response | null> => {
    if (hadBasePath || !routeClaimed) return null;
    return resolveInvalidRscCacheBustingRequest({ isRscRequest, request });
  };

  const runMiddleware = isOnDemandRevalidateRequest(
    request.headers.get(PRERENDER_REVALIDATE_HEADER),
  )
    ? undefined
    : options.runMiddleware;
  // Branch the exact downstream body owner before creating URL aliases. URL
  // reconstruction shares a stream; cloning an alias would lock the body still
  // referenced by `request` and break the subsequent action/route-handler read.
  const isolatedMiddlewareSource =
    runMiddleware && request.body && !request.bodyUsed ? request.clone() : null;

  // Keep cache-busting validation on the real request above, then hide the
  // internal `_rsc` transport query from userland middleware and post-middleware
  // has/missing matching. This mirrors Next.js' navigation middleware fixture.
  const normalizedUserlandRequest = requestWithoutRscSuffix(request);
  const userlandRequest = requestWithoutRscCacheBustingSearchParam(normalizedUserlandRequest);
  const isolatedMiddlewareRequest = isolatedMiddlewareSource
    ? requestWithoutRscCacheBustingSearchParam(requestWithoutRscSuffix(isolatedMiddlewareSource))
    : undefined;
  let didMiddlewareRewrite = false;
  let didMiddlewareRewritePathname = false;

  if (runMiddleware) {
    const middlewareResult = await runMiddleware({
      cleanPathname,
      context: middlewareContext,
      externalRewriteRequest: normalizedUserlandRequest,
      hadBasePath,
      isDataRequest: isMiddlewareDataRequest,
      middlewareRequest: isolatedMiddlewareRequest,
      request: userlandRequest,
      validateExternalRewriteRequest: () => validateClaimedOutsideBasePathRsc(true),
    });
    if (middlewareResult.kind === "response") {
      if (request.body && !request.body.locked) {
        void request.body.cancel().catch(() => {});
      }
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
  filesystemRouteEligible ||= didMiddlewareRewrite;

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
        validateExternalRewriteRequest: () => validateClaimedOutsideBasePathRsc(true),
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
          validateExternalRewriteRequest: () => validateClaimedOutsideBasePathRsc(true),
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
            validateExternalRewriteRequest: () => validateClaimedOutsideBasePathRsc(true),
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
  // Interception-only RSC targets promote their source route at this same
  // boundary so Server Action rerenders receive the same route and params as
  // the subsequent page dispatch. Document requests remain direct-route-only.
  const directPreActionMatch = filesystemRouteEligible ? matchCleanPathname() : null;
  const preActionRoutePathname = cleanPathnameIsRequestPathname
    ? requestCleanPathname
    : cleanPathname;
  // Interception renders the *source* route's tree for this request. Next.js
  // never does that: its generated rewrite points at the intercepting route and
  // the client keeps the segments it already holds, so only the requested target
  // is rendered server-side. Because vinext renders the source tree instead, one
  // request reaches a second route that the middleware run above never saw, since
  // that run received the target's cleanPathname. The source pathname arrives in
  // a client header, so authorize it before anything downstream renders from it.
  // Skipped when the source resolves to the route already matched and authorized
  // for this request, which is also the case where interception does not fire.
  const interceptionSourceMatch =
    filesystemRouteEligible &&
    interceptionSourcePathname !== null &&
    interceptionContextHeader !== null
      ? (options.matchInterceptRoute?.(
          preActionRoutePathname,
          interceptionContextHeader,
          interceptionIdHeader,
        ) ?? null)
      : null;
  const hasVerifiedInterceptionSource = provesConcreteInterceptionSource(interceptionSourceMatch);
  if (interceptionIdHeader !== null && !hasVerifiedInterceptionSource) {
    // The supplemental-refresh selector is an untrusted request header. Only
    // graph-owned identities that match this exact target and source may reach
    // rendering or shared caches; otherwise arbitrary short values can create
    // unbounded `_rsc` and Vary variants.
    options.clearRequestContext();
    setInterceptionResponseUncacheable(true);
    return badRequestResponse();
  }
  let bypassInterceptionContextCache = hasRawInterceptionContext && !hasVerifiedInterceptionSource;
  if (interceptionContextHeader !== null) {
    // Replace any direct-target proof after rewrites. Exact graph ownership is
    // the only point where the source identity is safe for shared variants.
    setInterceptionResponseUncacheable(bypassInterceptionContextCache);
  }
  let interceptionCacheProofInvalidated = false;
  const invalidateInterceptionCacheProof = (): void => {
    if (!hasRawInterceptionContext) return;
    interceptionCacheProofInvalidated = true;
    bypassInterceptionContextCache = true;
    setInterceptionResponseUncacheable(true);
  };
  if (
    interceptionSourceMatch !== null &&
    interceptionSourcePathname !== null &&
    runMiddleware &&
    interceptionSourceMatch.route !== directPreActionMatch?.route
  ) {
    const sourceUrl = new URL(userlandRequest.url);
    sourceUrl.search = new URL(resolvedUrl, url).search;
    sourceUrl.pathname = hadBasePath
      ? addBasePathToPathname(interceptionSourcePathname, options.basePath)
      : interceptionSourcePathname;
    // Clone before rebuilding the URL so runtimes that transfer Request bodies
    // cannot disturb the original Server Action branch. Release the temporary
    // clone when reconstruction leaves it readable.
    const sourceRequest = userlandRequest.body ? userlandRequest.clone() : userlandRequest;
    const sourceMiddlewareRequest = cloneRequestWithUrl(sourceRequest, sourceUrl.href);
    // Hybrid dev attaches the target route's middleware result so the RSC
    // entry does not execute it twice. This is a distinct source route and
    // must run middleware itself rather than replaying the target's decision.
    sourceMiddlewareRequest.headers.delete(VINEXT_MW_CTX_HEADER);
    // Strip Flight headers on this owned branch before applyAppMiddleware so
    // it does not need another body tee solely to hide transport metadata.
    for (const header of FLIGHT_HEADERS) sourceMiddlewareRequest.headers.delete(header);
    const targetHeadersContext = getHeadersContext();
    const targetRequestHeaders = targetHeadersContext
      ? new Headers(targetHeadersContext.headers)
      : null;
    targetRequestHeaders?.delete(VINEXT_MW_CTX_HEADER);
    for (const header of FLIGHT_HEADERS) targetRequestHeaders?.delete(header);
    // Chain source authorization from the request identity already established
    // by target middleware, while keeping transport-only headers hidden.
    if (targetRequestHeaders) {
      const sourceHeaderNames = Array.from(sourceMiddlewareRequest.headers.keys());
      for (const header of sourceHeaderNames) {
        sourceMiddlewareRequest.headers.delete(header);
      }
      for (const [name, value] of targetRequestHeaders) {
        sourceMiddlewareRequest.headers.append(name, value);
      }
    }
    const sourceMiddlewareContext: AppRscMiddlewareContext = {
      headers: null,
      requestHeaders: null,
      status: null,
    };
    const sourceHeadersContext = headersContextFromRequest(sourceMiddlewareRequest, {
      draftModeSecret: options.draftModeSecret,
    });
    // Keep source authorization in a child request context. In particular,
    // NextResponse.next({ request: { headers } }) mutates the live headers
    // context; allowing those overrides to escape would make the target render
    // observe headers from a different route.
    let sourceMiddlewareResult: ApplyAppMiddlewareResult;
    try {
      sourceMiddlewareResult = await runWithHeadersContext(sourceHeadersContext, () =>
        runMiddleware({
          cleanPathname: interceptionSourcePathname,
          // Deliberately not the request's `middlewareContext`. This run decides
          // whether the source route may render; it does not contribute headers
          // or status to the target's response, which belongs to another route.
          context: sourceMiddlewareContext,
          externalRewriteRequest: normalizedUserlandRequest,
          hadBasePath,
          isDataRequest: isMiddlewareDataRequest,
          request: sourceMiddlewareRequest,
          validateExternalRewriteRequest: () => validateClaimedOutsideBasePathRsc(true),
        }),
      );
    } finally {
      // Release every temporary branch owned by source authorization. Some
      // runtimes transfer sourceRequest into sourceMiddlewareRequest; the
      // body-state checks make the cleanup safe in both transfer and tee cases.
      if (
        sourceMiddlewareRequest.body &&
        !sourceMiddlewareRequest.bodyUsed &&
        !sourceMiddlewareRequest.body.locked
      ) {
        // Cancellation marks this throwaway branch as released immediately,
        // but its promise may not settle until another tee branch finishes.
        // Do not delay Server Action dispatch on a streaming request body.
        void sourceMiddlewareRequest.body.cancel().catch(() => {});
      }
      if (
        sourceRequest !== userlandRequest &&
        sourceRequest.body &&
        !sourceRequest.bodyUsed &&
        !sourceRequest.body.locked
      ) {
        void sourceRequest.body.cancel().catch(() => {});
      }
    }
    if (sourceMiddlewareResult.kind === "response") {
      options.clearRequestContext();
      return sourceMiddlewareResult.response;
    }
    // The source and target share one render context. Existing target headers
    // and all cookies are identity-bearing and may not be replaced/deleted by
    // source middleware. Pure header additions are safe to retain and are
    // copied into the live render context instead of silently discarded.
    let sourceHeadersCompatible = true;
    if (targetRequestHeaders) {
      for (const [name, value] of targetRequestHeaders) {
        if (sourceHeadersContext.headers.get(name) !== value) {
          sourceHeadersCompatible = false;
          break;
        }
      }
    }
    if (
      !targetHeadersContext ||
      !targetRequestHeaders ||
      !sourceHeadersCompatible ||
      !haveSameRequestCookies(targetHeadersContext.cookies, sourceHeadersContext.cookies)
    ) {
      options.clearRequestContext();
      return notFoundResponse();
    }
    let addedSourceHeader = false;
    for (const [name, value] of sourceHeadersContext.headers) {
      if (!targetRequestHeaders.has(name)) {
        targetHeadersContext.headers.set(name, value);
        addedSourceHeader = true;
      }
    }
    if (addedSourceHeader) {
      targetHeadersContext.readonlyHeaders = undefined;
    }
    if (sourceMiddlewareResult.rewritten) {
      // Rewrites such as locale insertion are valid only when they resolve to
      // the exact source route and params already selected for interception.
      // A different route, params, or query would authorize one identity and
      // render another, so fail closed instead.
      const rewrittenSourceMatch = options.matchRoute(sourceMiddlewareResult.cleanPathname);
      if (
        sourceMiddlewareResult.search !== sourceUrl.search ||
        rewrittenSourceMatch?.route !== interceptionSourceMatch.route ||
        !haveSamePageParams(rewrittenSourceMatch.params, interceptionSourceMatch.params)
      ) {
        options.clearRequestContext();
        return notFoundResponse();
      }
    }
  }
  const interceptionPreActionMatch =
    filesystemRouteEligible &&
    directPreActionMatch === null &&
    isRscRequest &&
    interceptionSourcePathname !== null
      ? interceptionSourceMatch
      : null;
  const preActionMatch = directPreActionMatch ?? interceptionPreActionMatch;
  const isInterceptionMatch = interceptionPreActionMatch !== null;
  if (preActionMatch) {
    setRootParams(pickRootParams(preActionMatch.params, preActionMatch.route.rootParamNames));
  }

  // A Pages client navigating to a path that middleware rewrites into App
  // territory needs `x-nextjs-rewrite` so it can hard-navigate; the body is an
  // unused placeholder. Only take this shortcut when the App match definitively
  // owns the rewrite target. A dynamic App match does not: a concrete Pages
  // route outranks it, so those fall through to the arbitration below, which
  // gives `renderPagesFallback` its chance to run getServerSideProps.
  if (
    pagesDataRequest &&
    didMiddlewareRewritePathname &&
    preActionMatch &&
    !preActionMatch.route.isDynamic
  ) {
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

  let sourceConfigHeaders: Headers | null = null;
  if (filesystemRouteEligible && isPostRequest && actionId && options.handleServerActionRequest) {
    sourceConfigHeaders = new Headers();
    const sourceConfigUrl = new URL(request.url);
    sourceConfigUrl.pathname = hadBasePath
      ? addBasePathToPathname(requestCleanPathname, options.basePath)
      : requestCleanPathname;
    await applyAppRscConfigHeaders(
      sourceConfigHeaders,
      cloneRequestWithUrl(request, sourceConfigUrl.toString()),
      {
        basePath: options.basePath,
        configHeaders: options.configHeaders,
        i18nConfig: options.i18nConfig,
        requestContext: preMiddlewareRequestContext,
      },
    );
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
          scriptNonce,
          routeMatch: preActionMatch,
          routePathname: preActionRoutePathname,
          dispatchRedirectTargetRequest: dispatchInternalRequest,
          sourceConfigHeaders,
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
      !isInterceptionMatch && (match === null || match.route.isDynamic)
        ? ((await options.renderPagesFallback?.({
            appRouteMatch: match ?? null,
            allowRscDocumentFallback:
              didMiddlewareRewritePathname || allowInternalRscDocumentFallback,
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
  if (!isInterceptionMatch && !resolvedLateRewritesForAction && (!match || match.route.isDynamic)) {
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
          validateExternalRewriteRequest: () => validateClaimedOutsideBasePathRsc(true),
        },
        matchPathname(cleanPathname),
      );
      if (afterFilesRewrite instanceof Response) {
        invalidateInterceptionCacheProof();
        return afterFilesRewrite;
      }
      if (!afterFilesRewrite) continue;
      resolvedUrl = mergeRewriteQuery(resolvedUrl, afterFilesRewrite);
      cleanPathname = pathnameForResolvedUrl(resolvedUrl);
      cleanPathnameIsRequestPathname = false;
      invalidateInterceptionCacheProof();
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
          validateExternalRewriteRequest: () => validateClaimedOutsideBasePathRsc(true),
        },
        matchPathname(cleanPathname),
      );
      if (fallbackRewrite instanceof Response) {
        invalidateInterceptionCacheProof();
        return fallbackRewrite;
      }
      if (!fallbackRewrite) continue;
      resolvedUrl = mergeRewriteQuery(resolvedUrl, fallbackRewrite);
      cleanPathname = pathnameForResolvedUrl(resolvedUrl);
      cleanPathnameIsRequestPathname = false;
      invalidateInterceptionCacheProof();
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

  if (interceptionCacheProofInvalidated && interceptionContextHeader !== null) {
    const finalInterceptionTargetPathname = cleanPathnameIsRequestPathname
      ? requestCleanPathname
      : cleanPathname;
    const finalInterceptionSourceMatch =
      filesystemRouteEligible && match !== null
        ? (options.matchInterceptRoute?.(
            finalInterceptionTargetPathname,
            interceptionContextHeader,
            interceptionIdHeader,
          ) ?? null)
        : null;
    const hasVerifiedFinalInterceptionSource =
      hasVerifiedInterceptionSource &&
      interceptionSourceMatch !== null &&
      provesConcreteInterceptionSource(finalInterceptionSourceMatch) &&
      finalInterceptionSourceMatch?.route === interceptionSourceMatch.route &&
      haveSamePageParams(finalInterceptionSourceMatch.params, interceptionSourceMatch.params);
    if (interceptionIdHeader !== null && !hasVerifiedFinalInterceptionSource) {
      options.clearRequestContext();
      setInterceptionResponseUncacheable(true);
      return badRequestResponse();
    }
    bypassInterceptionContextCache = !hasVerifiedFinalInterceptionSource;
    setInterceptionResponseUncacheable(bypassInterceptionContextCache);
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
      runMiddleware &&
      (middlewareContext.status === null ||
        middlewareContext.status === 200 ||
        middlewareContext.status === 404)
    ) {
      const response = buildNextDataNotFoundResponse();
      const headers = new Headers(response.headers);
      mergeMiddlewareResponseHeaders(headers, middlewareContext.headers);
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
      request: cloneRequestWithUrl(routeHandlerRequest, routeHandlerUrl.toString()),
      route,
      searchParams: resolvedSearchParams,
    });
  }

  const pageResponse = await options.dispatchMatchedPage({
    bypassInterceptionContextCache,
    clientReuseManifest,
    cleanPathname,
    displayPathname: canonicalPathname,
    formState,
    actionError: normalizedProgressiveActionError,
    actionFailed,
    handlerStart,
    interceptionContext: interceptionContextHeader,
    interceptionId: interceptionIdHeader,
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
  return async function appRscHandler(rawRequest, ctx, allowInternalRscDocumentFallback = false) {
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
    const executionContext = isExecutionContextLike(ctx)
      ? ctx
      : (getRequestExecutionContext() ?? null);
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
    const filteredHeaders = executionContext?.isInternalPagesRevalidation
      ? new Headers(rawRequest.headers)
      : filterInternalHeaders(rawRequest.headers);
    filteredHeaders.delete(VINEXT_REVALIDATE_HOST_HEADER);
    if (isForwardedActionContext(ctx)) {
      filteredHeaders.set("x-action-forwarded", "1");
    }
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

    const headersContext = headersContextFromRequest(request, {
      draftModeSecret: options.draftModeSecret,
    });
    const requestContext = createRequestContext({
      headersContext,
      executionContext,
      unstableCacheRevalidation: "background",
    });
    let interceptionResponseUncacheable = false;

    const responsePromise = runWithRequestContext(requestContext, () =>
      runWithPrerenderWorkUnit(
        async () => {
          ensureFetchPatch();
          const preMiddlewareRequestContext = requestContextFromRequest(request);
          const middlewareContext: AppRscMiddlewareContext = {
            headers: null,
            requestHeaders: null,
            status: null,
          };
          let response: Response;

          try {
            response = await handleAppRscRequest(
              options,
              request,
              preMiddlewareRequestContext,
              middlewareContext,
              isPagesDataRequest,
              isPagesDataRequest,
              pagesDataRequest,
              (internalRequest) => appRscHandler(internalRequest, ctx, true),
              allowInternalRscDocumentFallback,
              (uncacheable) => {
                interceptionResponseUncacheable = uncacheable;
              },
            );
          } catch (error) {
            if (process.env.NODE_ENV !== "production") {
              flattenErrorCauses(error);
            }
            throw error;
          }

          response = await finalizeAppRscResponse(response, request, {
            basePath: options.basePath,
            configHeaders: options.configHeaders,
            i18nConfig: options.i18nConfig,
            middlewareHeaders: middlewareContext.headers,
            requestContext: preMiddlewareRequestContext,
          });
          return interceptionResponseUncacheable
            ? markUnverifiedInterceptionResponseUncacheable(response)
            : response;
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
