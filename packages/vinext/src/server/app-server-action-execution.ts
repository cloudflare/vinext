import {
  _drainPendingRevalidations,
  getAndClearActionRevalidationKind,
  type ActionRevalidationKind,
} from "vinext/shims/cache-request-state";
import {
  isDraftModeRequest,
  setHeadersContext,
  type HeadersAccessPhase,
} from "vinext/shims/headers";
import {
  type FetchCacheMode,
  setCurrentFetchCacheMode,
  setCurrentFetchSoftTags,
  setCurrentForceDynamicFetchDefault,
} from "vinext/shims/fetch-cache";
import type { ReactFormState } from "react-dom/client";
import { createRootParamsUsageController, runWithRootParamsUsage } from "vinext/shims/root-params";
import { isExternalUrl } from "../utils/external-url.js";
import { splitPathSegments } from "../routing/utils.js";
import { addBasePathToPathname, hasBasePath, stripBasePath } from "../utils/base-path.js";
import {
  ACTION_FORWARDED_HEADER,
  ACTION_REDIRECT_HEADER,
  ACTION_REDIRECT_STATUS_HEADER,
  ACTION_REDIRECT_TYPE_HEADER,
  ACTION_REVALIDATED_HEADER,
  NEXT_ROUTER_STATE_TREE_HEADER,
  RSC_HEADER,
  VINEXT_MW_CTX_HEADER,
} from "./headers.js";
import {
  VINEXT_RSC_CONTENT_TYPE,
  VINEXT_RSC_VARY_HEADER,
  applyRscCompatibilityIdHeader,
  createRscRequestUrl,
  stripRscCacheBustingSearchParam,
} from "./app-rsc-cache-busting.js";
import { applyEdgeRuntimeHeader } from "./app-page-response.js";
import { resolveAppPageActionRerenderTarget } from "./app-page-request.js";
import { resolveAppPageNavigationParams } from "./app-page-element-builder.js";
import { deferUntilStreamConsumed } from "./app-page-stream.js";
import { buildAppPageTags } from "./implicit-tags.js";
import { mergeMiddlewareResponseHeaders } from "./middleware-response-headers.js";
import { getSetCookieName } from "./cookie-utils.js";
import { APP_RSC_RENDER_MODE_NAVIGATION, type AppRscRenderMode } from "./app-rsc-render-mode.js";
import {
  getNextErrorDigest,
  parseNextHttpErrorDigest,
  parseNextRedirectDigest,
} from "./next-error-digest.js";
import {
  attachRequestCfMetadata,
  validateCsrfOrigin,
  validateServerActionPayload,
} from "./request-pipeline.js";
import { readStreamAsTextWithLimit } from "../utils/text-stream.js";
import { buildRequestHeadersFromMiddlewareResponse } from "../utils/middleware-request-headers.js";
import { parseEdgeRequestCookieHeader } from "../utils/parse-cookie.js";
import {
  createServerActionNotFoundResponse,
  getServerActionNotFoundMessage,
  isServerActionNotFoundError,
} from "./server-action-not-found.js";
import { internalServerErrorResponse, payloadTooLargeResponse } from "./http-error-responses.js";
import { createStaticGenerationHeadersContext } from "./app-static-generation.js";
import { markAppRscResponseConfigHeadersApplied } from "./app-rsc-response-finalizer.js";

type AppPageParams = Record<string, string | string[]>;

type AppServerActionErrorReporter = (
  error: Error,
  request: { path: string; method: string; headers: Record<string, string> },
  route: { routerKind: "App Router"; routePath: string; routeType: "action" },
) => void;

type AppServerActionDecoder = (body: FormData) => Promise<unknown>;
type AppServerActionFormStateDecoder = (
  actionResult: unknown,
  body: FormData,
) => Promise<ReactFormState | undefined>;

type ReadFormDataWithLimit = (request: Request, maxBytes: number) => Promise<FormData>;

type ReadBodyWithLimit = (request: Request, maxBytes: number) => Promise<string>;

type AppServerActionFunction = (...args: unknown[]) => unknown;

type AppServerActionReturnValue =
  | {
      data: unknown;
      ok: true;
    }
  | {
      data: unknown;
      ok: false;
    };

type AppServerActionRedirect = {
  status: number;
  type: string;
  url: string;
};

type AppServerActionRoute = {
  page?: unknown;
  pattern: string;
  rootParamNames?: readonly string[];
  routeHandler?: unknown;
  /**
   * Manifest lazy-module thunks (see app-route-module-loader.ts). Present when
   * the route is lazy; `page`/`routeHandler` stay unset until hydration, so
   * these are what identify the route's kind without importing its modules.
   */
  __loadPage?: unknown;
  __loadRouteHandler?: unknown;
  routeSegments?: readonly string[];
  params?: readonly string[] | null;
  slots?: Readonly<
    Record<
      string,
      {
        default?: { default?: unknown } | null;
        page?: { default?: unknown } | null;
        slotPatternParts?: readonly string[] | null;
        slotParamNames?: readonly string[] | null;
      }
    >
  > | null;
};

/**
 * Side-effect headers captured during a progressive (no-JS) server action's
 * non-redirect execution. The caller (app-rsc-handler) must apply these to the
 * page render response so that `cookies().set(...)` and revalidation kinds
 * propagate to the browser. Without this, no-JS form submissions silently
 * lose cookie/header mutations — see issue #1483.
 *
 * Next.js' equivalent path mutates `res.setHeader('set-cookie', ...)` during
 * action execution (action-handler.ts → app-render.tsx), then `sendResponse`
 * merges those headers with the rendered Response. vinext works with Response
 * objects directly so the cookies must ride out via the result instead.
 */
type ProgressiveServerActionSideEffects = {
  /** `Set-Cookie` headers from `cookies().set(...)` / `cookies().delete(...)`. */
  pendingCookies: string[];
  /** `Set-Cookie` header from `draftMode().enable()/disable()` (if any). */
  draftCookie: string | null | undefined;
  /** Resolved revalidation kind to emit via `x-action-revalidated`. */
  revalidationKind: ActionRevalidationKind;
};

type AppServerActionRouteRuntime = "edge" | "experimental-edge" | "nodejs" | null;

type ProgressiveServerActionResult =
  | ({
      formState: ReactFormState | null;
      kind: "form-state";
    } & ProgressiveServerActionSideEffects)
  | ({
      actionError: unknown;
      actionFailed: true;
      formState: null;
      kind: "form-state";
    } & ProgressiveServerActionSideEffects);

type AppServerActionMatch<TRoute extends AppServerActionRoute> = {
  params: AppPageParams;
  route: TRoute;
};

type AppServerActionIntercept<TPage = unknown> = {
  matchedParams: AppPageParams;
  sourceMatchedParams?: AppPageParams;
  page: TPage;
  slotId?: string | null;
  slotKey: string;
  sourceRouteIndex: number;
};

type BuildServerActionPageElementOptions<TRoute extends AppServerActionRoute, TInterceptOpts> = {
  cleanPathname: string;
  interceptOpts: TInterceptOpts | undefined;
  isRscRequest: boolean;
  mountedSlotsHeader: string | null;
  params: AppPageParams;
  request: Request;
  route: TRoute;
  searchParams: URLSearchParams;
  scriptNonce?: string;
  renderMode: AppRscRenderMode;
  observeMetadataSearchParamsAccess?: boolean;
  observePageSearchParamsAccess?: boolean;
};

type AppServerActionRscModel<TElement> = {
  /**
   * Omitted when the action did not invalidate page data. This mirrors Next.js'
   * empty Flight payload for non-revalidating fetch actions: the client resolves
   * the action value without committing a visible router update.
   */
  root?: TElement;
  returnValue: AppServerActionReturnValue;
};

type RenderServerActionRscStreamOptions<TTemporaryReferences> = {
  onError: (error: unknown) => unknown;
  temporaryReferences: TTemporaryReferences;
};

type DecodeServerActionReplyOptions<TTemporaryReferences> = {
  temporaryReferences: TTemporaryReferences;
};

export type HandleProgressiveServerActionRequestOptions = {
  actionId: string | null;
  allowedOrigins: string[];
  /** Configured next.config `basePath`. Prefixed onto progressive Location targets. */
  basePath?: string;
  cleanPathname: string;
  clearRequestContext: () => void;
  contentType: string;
  decodeAction: AppServerActionDecoder;
  decodeFormState: AppServerActionFormStateDecoder;
  getAndClearPendingCookies: () => string[];
  getDraftModeCookieHeader: () => string | null | undefined;
  /**
   * Whether the posted-to route resolves to an App Router *page* (as opposed to
   * a route handler or no match). Multipart form POSTs to a page are always
   * server-action attempts in Next.js, so a body that decodes to no action must
   * surface as 404 action-not-found rather than rendering the page. Route
   * handlers (which run *after* this dispatch in vinext) legitimately receive
   * raw multipart POSTs, so they must still fall through. See issue #1340.
   */
  hasPageRoute: boolean;
  maxActionBodySize: number;
  middlewareHeaders: Headers | null;
  readFormDataWithLimit: ReadFormDataWithLimit;
  reportRequestError: AppServerActionErrorReporter;
  request: Request;
  setHeadersAccessPhase: (phase: HeadersAccessPhase) => HeadersAccessPhase;
};

export type HandleServerActionRscRequestOptions<
  TElement,
  TRoute extends AppServerActionRoute,
  TInterceptOpts,
  TTemporaryReferences,
  TPage = unknown,
> = {
  actionId: string | null;
  allowedOrigins: string[];
  /** Configured next.config `basePath`. Prefixed onto ACTION_REDIRECT_HEADER targets. */
  basePath?: string;
  buildPageElement: (
    options: BuildServerActionPageElementOptions<TRoute, TInterceptOpts>,
  ) => TElement;
  cleanPathname: string;
  clearRequestContext: () => void;
  contentType: string;
  /** Route selected at the request boundary before action execution. */
  currentRouteMatch: AppServerActionMatch<TRoute> | null;
  /** Request-aware pathname identity used for current-route interception lookup. */
  currentRoutePathname: string;
  createNotFoundElement: (routeId: string) => TElement;
  createPayloadRouteId: (pathname: string, interceptionContext: string | null) => string;
  createRscOnErrorHandler: (
    request: Request,
    pathname: string,
    pattern: string,
  ) => (error: unknown) => unknown;
  createTemporaryReferenceSet: () => TTemporaryReferences;
  decodeReply: (
    body: string | FormData,
    options: DecodeServerActionReplyOptions<TTemporaryReferences>,
  ) => Promise<unknown[]> | unknown[];
  draftModeSecret: string;
  /**
   * Hydrate a route's lazy page/route-handler modules before reading
   * `route.page` / `route.routeHandler` on action redirect targets and
   * re-render targets obtained via `matchRoute`/`getSourceRoute`. Idempotent.
   */
  ensureRouteLoaded?: (route: TRoute) => unknown;
  findIntercept: (pathname: string) => AppServerActionIntercept<TPage> | null;
  getAndClearPendingCookies: () => string[];
  getDraftModeCookieHeader: () => string | null | undefined;
  getRouteParamNames: (route: TRoute) => readonly string[];
  getSourceRoute: (sourceRouteIndex: number) => TRoute | undefined;
  isEdgeRuntime?: boolean;
  isRscRequest: boolean;
  loadServerAction: (actionId: string) => Promise<unknown>;
  /**
   * Match an action redirect target. Must use *request* route identity — the
   * raw, undecoded pathname — because the target is rendered as if the client
   * had navigated to it. A matcher that decodes would resolve an encoded alias
   * like `/%61dmin` to `/admin` and render a page the navigation itself, and
   * the middleware that just ran for `/%61dmin`, would never have reached.
   */
  matchRoute: (pathname: string) => AppServerActionMatch<TRoute> | null;
  maxActionBodySize: number;
  /** Verbatim `serverActions.bodySizeLimit` config string (e.g. "2mb") for the body-exceeded error. */
  maxActionBodySizeLabel: string;
  middlewareHeaders: Headers | null;
  /** Raw middleware response headers used to reconstruct request-header overrides. */
  middlewareRequestHeaders: Headers | null;
  middlewareStatus: number | null | undefined;
  /**
   * Dispatch a synthetic redirect-target GET through the complete App Router
   * request pipeline. The callback enters a fresh request context and returns
   * the finalized response, including config rules, middleware, routing, and
   * response headers.
   */
  dispatchRedirectTargetRequest: (request: Request) => Promise<Response>;
  /** next.config headers matched on the action source path, before middleware. */
  sourceConfigHeaders?: Headers | null;
  mountedSlotsHeader: string | null;
  readBodyWithLimit: ReadBodyWithLimit;
  readFormDataWithLimit: ReadFormDataWithLimit;
  renderToReadableStream: (
    model: AppServerActionRscModel<TElement>,
    options: RenderServerActionRscStreamOptions<TTemporaryReferences>,
  ) => BodyInit | null | Promise<BodyInit | null>;
  reportRequestError: AppServerActionErrorReporter;
  resolveRouteFetchCacheMode?: (route: TRoute) => FetchCacheMode | null;
  resolveRouteDynamicConfig?: (route: TRoute) => string | null | undefined;
  resolveRouteRuntime?: (route: TRoute) => AppServerActionRouteRuntime;
  request: Request;
  sanitizeErrorForClient: (error: unknown) => unknown;
  searchParams: URLSearchParams;
  setHeadersAccessPhase: (phase: HeadersAccessPhase) => HeadersAccessPhase;
  setNavigationContext: (context: {
    params: AppPageParams;
    pathname: string;
    searchParams: URLSearchParams;
  }) => void;
  toInterceptOpts: (intercept: AppServerActionIntercept<TPage>) => TInterceptOpts;
};

function prepareActionPageRerenderContext(options: {
  draftModeCookie: string | null | undefined;
  draftModeSecret: string;
  dynamicConfig: string | null | undefined;
  request: Request;
  routePattern: string;
  searchParams: URLSearchParams;
}): URLSearchParams {
  if (options.dynamicConfig === "force-static" || options.dynamicConfig === "error") {
    const rerenderRequest = createActionRerenderRequest({
      draftModeCookie: options.draftModeCookie,
      request: options.request,
    });
    setHeadersContext(
      createStaticGenerationHeadersContext({
        draftModeEnabled: isDraftModeRequest(rerenderRequest, options.draftModeSecret),
        draftModeSecret: options.draftModeSecret,
        dynamicConfig: options.dynamicConfig,
        routeKind: "page",
        routePattern: options.routePattern,
      }),
    );
  }
  return options.dynamicConfig === "force-static" ? new URLSearchParams() : options.searchParams;
}

function createActionRerenderRequest(options: {
  draftModeCookie: string | null | undefined;
  request: Request;
}): Request {
  if (!options.draftModeCookie) return options.request;

  const headers = new Headers(options.request.headers);
  const cookieHeader = applySetCookieMutationsToRequestCookieHeader(headers.get("cookie"), [
    options.draftModeCookie,
  ]);
  if (cookieHeader === null) {
    headers.delete("cookie");
  } else {
    headers.set("cookie", cookieHeader);
  }
  return new Request(options.request.url, { headers });
}

/**
 * Matches Next.js' server action argument cap to prevent stack overflow in
 * Function.prototype.apply when decoding hostile action payloads.
 */
const SERVER_ACTION_ARGS_LIMIT = 1000;
const ACTION_DID_NOT_REVALIDATE = 0 satisfies ActionRevalidationKind;
const ACTION_DID_REVALIDATE_STATIC_AND_DYNAMIC = 1 satisfies ActionRevalidationKind;
const ACTION_REDIRECT_RENDER_STRIPPED_HEADERS = [
  "content-length",
  "next-action",
  "rsc",
  "x-action-forwarded",
  "x-rsc-action",
  // Hybrid app+pages dev attaches the Pages handler's middleware result for the
  // *action* path. Left on the redirect target's request it would make
  // applyForwardedMiddlewareContext replay that result instead of executing
  // middleware for the target.
  VINEXT_MW_CTX_HEADER,
];

// Matches Next.js' actionsForbiddenHeaders. These describe the action
// response's framing/connection rather than the internal target GET and must
// not be forwarded as request headers.
const ACTION_REDIRECT_FORWARDED_FORBIDDEN_HEADERS = [
  "accept-encoding",
  "connection",
  "content-encoding",
  "content-length",
  "expect",
  "keep-alive",
  "keepalive",
  "set-cookie",
  "transfer-encoding",
];

// Headers that must not use ordinary response-over-request merging. Next.js
// explicitly removes its action header, vinext also has its own action/dev
// protocol headers, and Cookie is rebuilt separately from the original jar plus
// Set-Cookie mutations.
const ACTION_REDIRECT_FORWARDED_PROTOCOL_HEADERS = [
  "cookie",
  "next-action",
  "rsc",
  "x-action-forwarded",
  "x-rsc-action",
  VINEXT_MW_CTX_HEADER,
];

function setActionRevalidatedHeader(headers: Headers, kind: ActionRevalidationKind): void {
  if (kind === ACTION_DID_NOT_REVALIDATE) return;
  headers.set(ACTION_REVALIDATED_HEADER, JSON.stringify(kind));
}

function resolveActionRevalidationKind(hasModifiedCookies: boolean): ActionRevalidationKind {
  const revalidationKind = getAndClearActionRevalidationKind();
  // Cookie mutations are a hard override to STATIC_AND_DYNAMIC: any cookie
  // change can invalidate downstream cached payloads regardless of what
  // (if anything) the action explicitly revalidated, so we always emit the
  // strongest kind. STATIC_AND_DYNAMIC is also the lowest numeric value, so
  // this matches the max-precedence semantics in markActionRevalidation.
  if (hasModifiedCookies) return ACTION_DID_REVALIDATE_STATIC_AND_DYNAMIC;
  return revalidationKind;
}

function clearRejectedActionSideEffects(getAndClearPendingCookies: () => string[]): void {
  getAndClearPendingCookies();
  getAndClearActionRevalidationKind();
}

function cloneActionRedirectHeaders(
  requestHeaders: Headers,
  sourceConfigHeaders: Headers | null,
  actionMiddlewareHeaders: Headers | null,
): Headers {
  const headers = new Headers(requestHeaders);
  for (const header of ACTION_REDIRECT_FORWARDED_FORBIDDEN_HEADERS) {
    headers.delete(header);
  }
  for (const header of ACTION_REDIRECT_RENDER_STRIPPED_HEADERS) {
    headers.delete(header);
  }

  // Next.js' internal target GET merges ordinary action response headers over
  // the request headers before running the target pipeline. Merge after
  // stripping the action request's transport headers so a middleware-emitted
  // value such as Accept or Content-Type remains an intentional target header.
  for (const responseHeaders of [sourceConfigHeaders, actionMiddlewareHeaders]) {
    if (!responseHeaders) continue;
    for (const [name, value] of responseHeaders) {
      const normalizedName = name.toLowerCase();
      if (
        ACTION_REDIRECT_FORWARDED_FORBIDDEN_HEADERS.includes(normalizedName) ||
        ACTION_REDIRECT_FORWARDED_PROTOCOL_HEADERS.includes(normalizedName)
      ) {
        continue;
      }
      headers.set(name, value);
    }
  }
  return headers;
}

function readSetCookieNameValue(
  setCookie: string,
): { name: string; value: string | undefined } | null {
  const equalsIndex = setCookie.indexOf("=");
  if (equalsIndex <= 0) return null;

  const name = setCookie.slice(0, equalsIndex).trim();
  const valueEnd = setCookie.indexOf(";", equalsIndex + 1);
  const encodedValue = setCookie.slice(equalsIndex + 1, valueEnd === -1 ? undefined : valueEnd);

  let onceDecodedValue = encodedValue;
  try {
    onceDecodedValue = decodeURIComponent(encodedValue);
  } catch {
    // Manually emitted/config Set-Cookie values need not be URI-encoded. Keep
    // their raw value so the target cannot retain the stale inbound cookie.
  }

  let value: string;
  try {
    // ResponseCookies parses the pair once, then parseSetCookie decodes the
    // extracted value again before RequestCookies serializes it.
    value = decodeURIComponent(onceDecodedValue);
  } catch {
    // Next.js lets this second decode throw. Keep the valid first decode as a
    // robustness exception so the target cannot retain a stale cookie value.
    value = onceDecodedValue;
  }

  // @edge-runtime/cookies compacts an empty value out of the parsed response
  // cookie. getForwardedHeaders treats that undefined value as a deletion.
  return { name, value: value === "" ? undefined : value };
}

function applySetCookieMutationsToRequestCookieHeader(
  cookieHeader: string | null,
  setCookies: readonly string[],
): string | null {
  const cookies = parseEdgeRequestCookieHeader(cookieHeader ?? "");
  const responseCookies = new Map<string, string | undefined>();

  for (const setCookie of setCookies) {
    const entry = readSetCookieNameValue(setCookie);
    if (!entry) continue;
    // ResponseCookies stores response mutations in a name-keyed Map before
    // getForwardedHeaders applies them. Repeated names therefore collapse to
    // the last value without changing their first insertion order.
    responseCookies.set(entry.name, entry.value);
  }

  for (const [name, value] of responseCookies) {
    // Match Next.js' ResponseCookies -> RequestCookies projection exactly:
    // attributes such as Path and Max-Age are discarded, while a compacted
    // empty value deletes the request cookie.
    if (value === undefined) cookies.delete(name);
    else cookies.set(name, value);
  }

  return cookies.size === 0
    ? null
    : [...cookies].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join("; ");
}

async function createActionRedirectTargetRequest(options: {
  actionMiddlewareHeaders: Headers | null;
  actionMiddlewareRequestHeaders: Headers | null;
  pendingCookies: readonly string[];
  request: Request;
  sourceConfigHeaders: Headers | null;
  url: URL;
}): Promise<Request> {
  // App middleware request overrides are applied to headers()/cookies() through
  // ALS, while the Request object remains the pre-middleware request. Next.js
  // mutates req.headers before its internal target GET, so reconstruct that
  // effective request here before forwarding ordinary response headers.
  const effectiveRequestHeaders = options.actionMiddlewareRequestHeaders
    ? (buildRequestHeadersFromMiddlewareResponse(
        options.request.headers,
        options.actionMiddlewareRequestHeaders,
      ) ?? options.request.headers)
    : options.request.headers;
  const headers = cloneActionRedirectHeaders(
    effectiveRequestHeaders,
    options.sourceConfigHeaders,
    options.actionMiddlewareHeaders,
  );
  const cookieHeader = applySetCookieMutationsToRequestCookieHeader(
    headers.get("cookie"),
    options.pendingCookies,
  );
  // Next.js unconditionally assigns RequestCookies.toString() to the internal
  // target request, so an empty jar is represented as Cookie: rather than by
  // omitting the header.
  headers.set("cookie", cookieHeader ?? "");

  // Match Next.js' internal redirect fetch: it is a fresh full-tree RSC GET,
  // not another action request or a patch against the action route's tree.
  headers.set(RSC_HEADER, "1");
  headers.delete(NEXT_ROUTER_STATE_TREE_HEADER);
  stripRscCacheBustingSearchParam(options.url);
  const requestPath = await createRscRequestUrl(
    `${options.url.pathname}${options.url.search}`,
    headers,
  );
  const requestUrl = new URL(requestPath, options.url.origin);

  return attachRequestCfMetadata(
    new Request(requestUrl, { headers, method: "GET" }),
    options.request,
  );
}

const ACTION_REDIRECT_MAX_INTERNAL_REDIRECTS = 20;
const FOLLOWABLE_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

async function createActionRedirectFollowRequest(request: Request, url: URL): Promise<Request> {
  stripRscCacheBustingSearchParam(url);
  const requestPath = await createRscRequestUrl(`${url.pathname}${url.search}`, request.headers);
  return attachRequestCfMetadata(
    new Request(new URL(requestPath, url.origin), {
      headers: request.headers,
      method: "GET",
    }),
    request,
  );
}

/**
 * Resolve a same-origin redirect target through the real App request pipeline.
 * This mirrors the redirect-following behavior of Next.js' internal fetch while
 * avoiding a network round trip back into the current Worker/dev server.
 */
async function dispatchActionRedirectTarget(options: {
  basePath: string;
  dispatch: (request: Request) => Promise<Response>;
  request: Request;
}): Promise<Response | null> {
  let request = options.request;

  for (
    let redirectCount = 0;
    redirectCount <= ACTION_REDIRECT_MAX_INTERNAL_REDIRECTS;
    redirectCount++
  ) {
    const response = await options.dispatch(request);
    const location = response.headers.get("location");
    if (!location || !FOLLOWABLE_REDIRECT_STATUSES.has(response.status)) {
      return response;
    }

    response.body?.cancel().catch(() => {});
    if (redirectCount === ACTION_REDIRECT_MAX_INTERNAL_REDIRECTS) return null;

    const nextUrl = new URL(location, request.url);
    const currentUrl = new URL(request.url);
    if (
      nextUrl.origin !== currentUrl.origin ||
      (options.basePath !== "" && !hasBasePath(nextUrl.pathname, options.basePath))
    ) {
      return null;
    }
    request = await createActionRedirectFollowRequest(request, nextUrl);
  }

  return null;
}

/** Headers the internally dispatched target must not replace on the action wrapper. */
const ACTION_REDIRECT_PROTECTED_HEADERS = [
  // Next.js does not copy these connection/framing headers from the internal
  // target GET onto the action wrapper. This also protects the wrapper's
  // source/action Set-Cookie values while preventing target cookies from being
  // copied, matching actionsForbiddenHeaders in Next.js.
  ...ACTION_REDIRECT_FORWARDED_FORBIDDEN_HEADERS,
  "content-type",
  "location",
  ACTION_REDIRECT_HEADER,
  ACTION_REDIRECT_TYPE_HEADER,
  ACTION_REDIRECT_STATUS_HEADER,
  ACTION_REVALIDATED_HEADER,
];

const ACTION_REDIRECT_SOURCE_PROTECTED_HEADERS = ACTION_REDIRECT_PROTECTED_HEADERS.filter(
  (name) => name !== "set-cookie",
);

function mergeActionRedirectSourceHeaders(target: Headers, responseHeaders: Headers | null): void {
  if (!responseHeaders) return;

  const protectedValues = ACTION_REDIRECT_SOURCE_PROTECTED_HEADERS.map(
    (name) => [name, target.get(name)] as const,
  );
  mergeMiddlewareResponseHeaders(target, responseHeaders);
  for (const [name, value] of protectedValues) {
    if (value === null) target.delete(name);
    else target.set(name, value);
  }
}

/**
 * Copy ordinary target response headers onto the action redirect wrapper.
 * Next.js uses setHeader here, so target values replace source values instead
 * of using middleware-specific merge behavior such as unioning Vary.
 */
function mergeActionRedirectTargetHeaders(target: Headers, responseHeaders: Headers | null): void {
  if (!responseHeaders) return;

  for (const [name, value] of responseHeaders) {
    if (ACTION_REDIRECT_PROTECTED_HEADERS.includes(name.toLowerCase())) continue;
    target.set(name, value);
  }
}

function withoutRscBodyHeaders(headers: Headers): Headers {
  const nextHeaders = new Headers(headers);
  nextHeaders.delete("Content-Type");
  nextHeaders.delete("Vary");
  return nextHeaders;
}

function isReadableStreamBody(body: BodyInit | null): body is ReadableStream<Uint8Array> {
  return typeof ReadableStream !== "undefined" && body instanceof ReadableStream;
}

function createServerActionRscResponse(
  body: BodyInit | null,
  init: ResponseInit,
  clearRequestContext: () => void,
): Response {
  if (!isReadableStreamBody(body)) {
    clearRequestContext();
    return new Response(body, init);
  }

  return new Response(deferUntilStreamConsumed(body, clearRequestContext), init);
}

function isRequestBodyTooLarge(error: unknown): boolean {
  return error instanceof Error && error.message === "Request body too large";
}

/**
 * Build the error thrown when a server-action request body exceeds the
 * configured size limit. Matches Next.js' `Body exceeded {limit} limit.`
 * message + docs link (action-handler.ts) verbatim — including the original
 * config string (e.g. "2mb") — so it reads identically in logs.
 */
function createBodyExceededError(limitLabel: string): Error {
  return new Error(
    `Body exceeded ${limitLabel} limit.\n` +
      "To configure the body size limit for Server Actions, see: " +
      "https://nextjs.org/docs/app/api-reference/next-config-js/serverActions#bodysizelimit",
  );
}

/**
 * Collapse repeated `cookies().set(name, ...)` / `cookies().delete(name)`
 * calls down to the last value per name, matching Next.js'
 * `MutableRequestCookiesAdapter` semantics. Next.js stores response cookies in
 * a `ResponseCookies` Map keyed by name — multiple sets for the same cookie
 * collapse to the final value, and emit a single Set-Cookie header.
 *
 * Insertion order is preserved by first occurrence (Map iteration order),
 * which mirrors how `ResponseCookies` iterates its underlying Map. See
 * packages/next/src/server/web/spec-extension/adapters/request-cookies.ts.
 * Issue: https://github.com/cloudflare/vinext/issues/1481
 */
function dedupePendingCookies(cookies: readonly string[]): string[] {
  if (cookies.length <= 1) {
    return cookies.slice();
  }
  const byName = new Map<string, string>();
  const unkeyed: string[] = [];
  for (const cookie of cookies) {
    const name = getSetCookieName(cookie);
    if (name === null) {
      unkeyed.push(cookie);
      continue;
    }
    // Map.set on an existing key replaces the value but preserves the
    // insertion position of the original key — exactly the behaviour we need
    // for `cookies().set("foo", "1"); cookies().set("bar", "2"); cookies().set("foo", "3")`
    // to come out as [foo=3, bar=2].
    byName.set(name, cookie);
  }
  return [...unkeyed, ...byName.values()];
}

function isAppServerActionFunction(action: unknown): action is AppServerActionFunction {
  return typeof action === "function";
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function getServerActionFailureMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function validateServerActionArgs(args: readonly unknown[]): void {
  if (args.length > SERVER_ACTION_ARGS_LIMIT) {
    throw new Error(
      `Server Action arguments list is too long (${args.length}). Maximum allowed is ${SERVER_ACTION_ARGS_LIMIT}.`,
    );
  }
}

export async function readActionBodyWithLimit(request: Request, maxBytes: number): Promise<string> {
  if (!request.body) return "";
  return readStreamAsTextWithLimit(request.body, maxBytes, () => {
    throw new Error("Request body too large");
  });
}

export async function readActionFormDataWithLimit(
  request: Request,
  maxBytes: number,
): Promise<FormData> {
  if (!request.body) return new FormData();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalSize = 0;

  for (;;) {
    const result = await reader.read();
    if (result.done) break;

    totalSize += result.value.byteLength;
    if (totalSize > maxBytes) {
      void reader.cancel();
      throw new Error("Request body too large");
    }
    chunks.push(result.value);
  }

  const combined = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new Response(combined, {
    headers: { "Content-Type": request.headers.get("content-type") || "" },
  }).formData();
}

function getActionRedirect(error: unknown): AppServerActionRedirect | null {
  const digest = getNextErrorDigest(error);
  if (!digest) return null;

  const redirect = parseNextRedirectDigest(digest);
  if (!redirect) return null;

  return {
    status: redirect.status,
    type: redirect.type ?? "push",
    url: redirect.url,
  };
}

/**
 * Prepend the configured next.config `basePath` to a server-action redirect
 * target before it goes on the wire.
 *
 * `redirect("/foo")` called from a server action mounted at `/base/...` must
 * land the browser at `/base/foo`, mirroring how Next.js threads basePath
 * through `addPathPrefix(getURLFromRedirectError(err), basePath)` in
 * `app-render.tsx` for SSR redirects and in `action-handler.ts` for action
 * redirects.
 *
 * Idempotent and external-aware:
 *  - Empty basePath → returned unchanged.
 *  - External URLs (`http://`, `https://`, `data:`, protocol-relative `//`)
 *    are returned unchanged because the framework does not own those routes.
 *  - Targets that already start with the configured basePath are returned
 *    unchanged so this helper can be applied at any layer without risk of
 *    double-prefixing (`/base/base/foo`).
 *
 * Exported for tests. Used by both the progressive (no-JS form POST) and
 * RSC (`ACTION_REDIRECT_HEADER`) action redirect paths below.
 *
 * @see https://github.com/vercel/next.js/blob/canary/packages/next/src/server/app-render/action-handler.ts
 */
export function applyActionRedirectBasePath(url: string, basePath: string): string {
  if (!basePath) return url;
  if (isExternalUrl(url)) return url;
  // Pathnames that already include basePath are returned as-is.
  if (hasBasePath(url, basePath)) return url;
  // Relative or hash/query-only targets cannot be prefixed safely without an
  // origin; leave them to the caller's URL resolution.
  if (!url.startsWith("/")) return url;
  // Split off optional query+hash so addBasePathToPathname only operates on
  // the path. We must accept hash too because Next.js redirect targets may
  // contain "#anchor".
  const queryIndex = url.indexOf("?");
  const hashIndex = url.indexOf("#");
  const splitAt =
    queryIndex === -1 ? hashIndex : hashIndex === -1 ? queryIndex : Math.min(queryIndex, hashIndex);
  const pathname = splitAt === -1 ? url : url.slice(0, splitAt);
  const suffix = splitAt === -1 ? "" : url.slice(splitAt);
  return `${addBasePathToPathname(pathname, basePath)}${suffix}`;
}

function buildServerActionPageTags(route: AppServerActionRoute, pathname: string): string[] {
  return buildAppPageTags(pathname, [], route.routeSegments ?? []);
}

function resolveInternalActionRedirectTarget(
  redirectUrl: string,
  requestUrl: string,
  basePath: string,
): URL | null {
  try {
    const parsedRequestUrl = new URL(requestUrl);
    let resolvedBase = requestUrl;
    if (!redirectUrl.startsWith("/") && !/^[a-z]+:/i.test(redirectUrl)) {
      let pathname = parsedRequestUrl.pathname;
      if (!pathname.endsWith("/")) {
        pathname = pathname + "/";
      }
      resolvedBase = `${parsedRequestUrl.origin}${pathname}${parsedRequestUrl.search}`;
    }

    const resolved = new URL(redirectUrl, resolvedBase);
    if (resolved.origin !== parsedRequestUrl.origin) return null;
    if (basePath && !hasBasePath(resolved.pathname, basePath)) return null;
    return resolved;
  } catch {
    return null;
  }
}

function isAncestorRouteRedirect(targetPathname: string, currentPathname: string): boolean {
  return targetPathname !== "/" && currentPathname.startsWith(`${targetPathname}/`);
}

function isStaleChildSiblingRouteRedirect(
  targetPathname: string,
  currentPathname: string,
): boolean {
  const targetSegments = splitPathSegments(targetPathname);
  const currentSegments = splitPathSegments(currentPathname);
  // Only deeper-to-shallower redirects can be stale in the Next.js worker
  // model (same-depth siblings share the same page worker). The depth guard
  // ensures we don't misclassify same-level redirects.
  if (targetSegments.length === 0 || currentSegments.length <= targetSegments.length) {
    return false;
  }

  let commonPrefixLength = 0;
  const maxPrefixLength = Math.min(targetSegments.length, currentSegments.length);
  while (
    commonPrefixLength < maxPrefixLength &&
    targetSegments[commonPrefixLength] === currentSegments[commonPrefixLength]
  ) {
    commonPrefixLength++;
  }

  return commonPrefixLength > 0 && commonPrefixLength < targetSegments.length;
}

function normalizeRuntime(runtime: AppServerActionRouteRuntime): "edge" | "nodejs" {
  if (runtime === "edge" || runtime === "experimental-edge") {
    return "edge";
  }
  return "nodejs";
}

function shouldUseForwardedActionRedirectStatus<TRoute extends AppServerActionRoute>(options: {
  actionWasForwarded: boolean;
  currentPathname: string;
  currentRoute: TRoute | null;
  resolveRouteRuntime?: (route: TRoute) => AppServerActionRouteRuntime;
  targetPathname: string;
  targetRoute: TRoute | null;
}): boolean {
  if (options.actionWasForwarded) return true;
  if (isAncestorRouteRedirect(options.targetPathname, options.currentPathname)) return true;
  if (isStaleChildSiblingRouteRedirect(options.targetPathname, options.currentPathname)) {
    return true;
  }
  if (!options.currentRoute || !options.targetRoute || !options.resolveRouteRuntime) return false;

  const currentRuntime = normalizeRuntime(options.resolveRouteRuntime(options.currentRoute));
  const targetRuntime = normalizeRuntime(options.resolveRouteRuntime(options.targetRoute));
  return currentRuntime !== targetRuntime;
}

function getActionHttpFallbackStatus(error: unknown): number | null {
  const digest = getNextErrorDigest(error);
  if (!digest) return null;

  const httpError = parseNextHttpErrorDigest(digest);
  if (!httpError || !Number.isInteger(httpError.status)) return null;

  return httpError.status;
}

function createServerActionErrorResponse(
  error: unknown,
  options: {
    cleanPathname: string;
    clearRequestContext: () => void;
    getAndClearPendingCookies: () => string[];
    reportRequestError: AppServerActionErrorReporter;
    request: Request;
  },
): Response {
  options.getAndClearPendingCookies();
  console.error("[vinext] Server action error:", error);
  options.reportRequestError(
    normalizeError(error),
    {
      path: options.cleanPathname,
      method: options.request.method,
      headers: Object.fromEntries(options.request.headers.entries()),
    },
    { routerKind: "App Router", routePath: options.cleanPathname, routeType: "action" },
  );
  options.clearRequestContext();
  return internalServerErrorResponse(
    process.env.NODE_ENV === "production"
      ? undefined
      : "Server action failed: " + getServerActionFailureMessage(error),
  );
}

function createActionNotFoundResponse(
  actionId: string | null,
  options: {
    clearRequestContext: () => void;
    getAndClearPendingCookies: () => string[];
  },
): Response {
  options.getAndClearPendingCookies();
  console.warn(getServerActionNotFoundMessage(actionId));
  options.clearRequestContext();
  return createServerActionNotFoundResponse();
}

export function isProgressiveServerActionRequest(
  request: Pick<Request, "method">,
  contentType: string,
  actionId: string | null,
): boolean {
  return (
    request.method.toUpperCase() === "POST" &&
    contentType.startsWith("multipart/form-data") &&
    !actionId
  );
}

export async function handleProgressiveServerActionRequest(
  options: HandleProgressiveServerActionRequestOptions,
): Promise<Response | ProgressiveServerActionResult | null> {
  if (!isProgressiveServerActionRequest(options.request, options.contentType, options.actionId)) {
    return null;
  }

  // Progressive form submissions (multipart form data without an actionId)
  // don't carry a forwarded-action header. They route to the visible page
  // directly and can't be redirected cross-runtime, so no forwarded guard is
  // needed here.
  const csrfResponse = validateCsrfOrigin(options.request, options.allowedOrigins);
  if (csrfResponse) {
    return csrfResponse;
  }

  const contentLength = parseInt(options.request.headers.get("content-length") || "0", 10);
  if (contentLength > options.maxActionBodySize) {
    options.clearRequestContext();
    return payloadTooLargeResponse();
  }

  try {
    let body: FormData;
    try {
      // Progressive submissions can still fall through to a regular page render when
      // the multipart body is not an action payload. Read a clone so that fallback
      // code can still consume the original request body.
      body = await options.readFormDataWithLimit(
        options.request.clone(),
        options.maxActionBodySize,
      );
    } catch (error) {
      if (isRequestBodyTooLarge(error)) {
        options.clearRequestContext();
        return payloadTooLargeResponse();
      }
      throw error;
    }

    const payloadResponse = await validateServerActionPayload(body);
    if (payloadResponse) {
      clearRejectedActionSideEffects(options.getAndClearPendingCookies);
      options.clearRequestContext();
      return payloadResponse;
    }

    const action = await options.decodeAction(body);
    if (!isAppServerActionFunction(action)) {
      // A multipart POST to a *page* is always a server-action attempt; a body
      // that decodes to no action means the referenced action doesn't exist
      // (e.g. the build has no server actions). Mirror Next.js' 404 +
      // action-not-found rather than rendering the page. Route handlers run
      // after this dispatch and legitimately receive raw multipart POSTs, so
      // fall through for them (and for unmatched routes). See issue #1340.
      if (options.hasPageRoute) {
        return createActionNotFoundResponse(null, {
          clearRequestContext: options.clearRequestContext,
          getAndClearPendingCookies: options.getAndClearPendingCookies,
        });
      }
      return null;
    }

    let actionRedirect: AppServerActionRedirect | null = null;
    let actionError: unknown = undefined;
    let actionFailed = false;
    let actionThrew = false;
    let actionResult: unknown;
    const rootParamsUsage = createRootParamsUsageController();
    const previousHeadersPhase = options.setHeadersAccessPhase("action");
    try {
      actionResult = await runWithRootParamsUsage(
        { kind: "server-action" },
        action,
        rootParamsUsage,
      );
    } catch (error) {
      actionThrew = true;
      actionRedirect = getActionRedirect(error);
      if (!actionRedirect) {
        actionError = error;
        actionFailed = true;
        const isControlFlow =
          getActionHttpFallbackStatus(error) !== null || isServerActionNotFoundError(error, null);
        if (!isControlFlow) {
          console.error("[vinext] Server action error:", error);
          options.reportRequestError(
            normalizeError(error),
            {
              path: options.cleanPathname,
              method: options.request.method,
              headers: Object.fromEntries(options.request.headers.entries()),
            },
            { routerKind: "App Router", routePath: options.cleanPathname, routeType: "action" },
          );
        }
      }
    } finally {
      options.setHeadersAccessPhase(previousHeadersPhase);
      if (actionThrew) rootParamsUsage.transitionToRender();
    }

    // Next.js applies cache invalidations before the action's follow-up render
    // so updateTag() provides read-your-own-writes semantics even though its
    // public return type is void.
    await _drainPendingRevalidations();

    if (!actionRedirect) {
      if (!actionThrew) rootParamsUsage.transitionToRender();
      // Capture cookies/headers set during action execution so the caller can
      // apply them to the rendered page response. Mirrors Next.js'
      // `res.setHeader('set-cookie', ...)` path in app-render.tsx, which
      // flushes `requestStore.mutableCookies` onto the response before SSR
      // streaming begins. Without this, no-JS server-action form POSTs lose
      // cookies/headers — see issue #1483.
      //
      // Dedupe by name (last value wins) before returning, matching the
      // redirect branch below and the RSC paths. Next.js' mutable cookies are
      // a name-keyed `ResponseCookies` map, so two `cookies().set("x", ...)`
      // calls collapse to a single Set-Cookie; without this, the no-JS
      // non-redirect path would emit one Set-Cookie per call — see issue #1976.
      const actionPendingCookies = dedupePendingCookies(options.getAndClearPendingCookies());
      const actionDraftCookie = options.getDraftModeCookieHeader();
      const revalidationKind = resolveActionRevalidationKind(
        actionPendingCookies.length > 0 || Boolean(actionDraftCookie),
      );

      if (actionFailed) {
        return {
          kind: "form-state",
          formState: null,
          actionError,
          actionFailed,
          pendingCookies: actionPendingCookies,
          draftCookie: actionDraftCookie,
          revalidationKind,
        };
      }

      const formState = await options.decodeFormState(actionResult, body);
      return {
        kind: "form-state",
        formState: formState ?? null,
        pendingCookies: actionPendingCookies,
        draftCookie: actionDraftCookie,
        revalidationKind,
      };
    }

    const actionPendingCookies = dedupePendingCookies(options.getAndClearPendingCookies());
    const actionDraftCookie = options.getDraftModeCookieHeader();
    const actionRevalidationKind = resolveActionRevalidationKind(
      actionPendingCookies.length > 0 || Boolean(actionDraftCookie),
    );
    options.clearRequestContext();

    const headers = new Headers();
    // Prefix the configured basePath onto the redirect target before it
    // becomes an absolute Location URL. Mirrors Next.js, which threads
    // basePath through `addPathPrefix(...)` for server-action redirects.
    const prefixedRedirectUrl = applyActionRedirectBasePath(
      actionRedirect.url,
      options.basePath ?? "",
    );
    headers.set("Location", new URL(prefixedRedirectUrl, options.request.url).toString());
    mergeMiddlewareResponseHeaders(headers, options.middlewareHeaders);
    for (const cookie of actionPendingCookies) {
      headers.append("Set-Cookie", cookie);
    }
    if (actionDraftCookie) {
      headers.append("Set-Cookie", actionDraftCookie);
    }
    setActionRevalidatedHeader(headers, actionRevalidationKind);

    return new Response(null, {
      status: 303,
      headers,
    });
  } catch (error) {
    if (isServerActionNotFoundError(error, null)) {
      return createActionNotFoundResponse(null, {
        clearRequestContext: options.clearRequestContext,
        getAndClearPendingCookies: options.getAndClearPendingCookies,
      });
    }

    getAndClearActionRevalidationKind();
    options.getAndClearPendingCookies();
    console.error("[vinext] Server action payload parsing error:", error);
    options.reportRequestError(
      normalizeError(error),
      {
        path: options.cleanPathname,
        method: options.request.method,
        headers: Object.fromEntries(options.request.headers.entries()),
      },
      { routerKind: "App Router", routePath: options.cleanPathname, routeType: "action" },
    );
    options.clearRequestContext();
    return internalServerErrorResponse(
      process.env.NODE_ENV === "production"
        ? undefined
        : "Server action parsing failed: " + getServerActionFailureMessage(error),
    );
  }
}

/**
 * Render the response for a fetch (client-invoked) server action whose request
 * body exceeds the configured `serverActions.bodySizeLimit`.
 *
 * Next.js does not return a bare 413 here: it throws the body-exceeded error
 * before the action runs, then — for fetch actions — emits a Flight response
 * with status 500 carrying the rejected action result, so the nearest client
 * error boundary catches it (see action-handler.ts, the `isFetchAction` branch
 * of the generic error path). vinext mirrors that by rendering a Flight stream
 * with `returnValue: { ok: false }` and no page root (the action never ran, so
 * nothing was revalidated and the page render is skipped). A bare 413 plain
 * response would bypass the boundary and surface the wrong status/content-type.
 */
async function renderFetchActionBodyExceededResponse<
  TElement,
  TRoute extends AppServerActionRoute,
  TInterceptOpts,
  TTemporaryReferences,
  TPage,
>(
  options: HandleServerActionRscRequestOptions<
    TElement,
    TRoute,
    TInterceptOpts,
    TTemporaryReferences,
    TPage
  >,
): Promise<Response> {
  const error = createBodyExceededError(options.maxActionBodySizeLabel);
  console.error("[vinext] Server action error:", error);
  options.reportRequestError(
    normalizeError(error),
    {
      path: options.cleanPathname,
      method: options.request.method,
      headers: Object.fromEntries(options.request.headers.entries()),
    },
    { routerKind: "App Router", routePath: options.cleanPathname, routeType: "action" },
  );
  // Discard any side effects accumulated before the limit was hit.
  getAndClearActionRevalidationKind();
  options.getAndClearPendingCookies();

  const returnValue: AppServerActionReturnValue = {
    ok: false,
    data: options.sanitizeErrorForClient(error),
  };
  const temporaryReferences = options.createTemporaryReferenceSet();
  const onRenderError = options.createRscOnErrorHandler(
    options.request,
    options.cleanPathname,
    options.cleanPathname,
  );
  const rscStream = await options.renderToReadableStream(
    { returnValue },
    { temporaryReferences, onError: onRenderError },
  );

  const headers = new Headers({
    "Content-Type": VINEXT_RSC_CONTENT_TYPE,
    Vary: VINEXT_RSC_VARY_HEADER,
  });
  applyEdgeRuntimeHeader(headers, options.isEdgeRuntime);
  mergeMiddlewareResponseHeaders(headers, options.middlewareHeaders);
  applyRscCompatibilityIdHeader(headers);

  return createServerActionRscResponse(
    rscStream,
    { status: 500, headers },
    options.clearRequestContext,
  );
}

export async function handleServerActionRscRequest<
  TElement,
  TRoute extends AppServerActionRoute,
  TInterceptOpts,
  TTemporaryReferences,
  TPage = unknown,
>(
  options: HandleServerActionRscRequestOptions<
    TElement,
    TRoute,
    TInterceptOpts,
    TTemporaryReferences,
    TPage
  >,
): Promise<Response | null> {
  if (options.request.method.toUpperCase() !== "POST" || !options.actionId) {
    return null;
  }

  const csrfResponse = validateCsrfOrigin(options.request, options.allowedOrigins);
  if (csrfResponse) return csrfResponse;

  const contentLength = parseInt(options.request.headers.get("content-length") || "0", 10);
  if (contentLength > options.maxActionBodySize) {
    if (options.request.body) {
      void options.request.body.cancel().catch(() => {});
    }
    return renderFetchActionBodyExceededResponse(options);
  }

  try {
    let action: AppServerActionFunction | undefined;
    if (options.contentType.startsWith("multipart/form-data")) {
      let loadedAction: unknown;
      try {
        loadedAction = await options.loadServerAction(options.actionId);
      } catch (error) {
        if (isServerActionNotFoundError(error, options.actionId)) {
          return createActionNotFoundResponse(options.actionId, {
            clearRequestContext: options.clearRequestContext,
            getAndClearPendingCookies: options.getAndClearPendingCookies,
          });
        }

        throw error;
      }

      if (!isAppServerActionFunction(loadedAction)) {
        return createActionNotFoundResponse(options.actionId, {
          clearRequestContext: options.clearRequestContext,
          getAndClearPendingCookies: options.getAndClearPendingCookies,
        });
      }
      action = loadedAction;
    }

    let body: string | FormData;
    try {
      body = options.contentType.startsWith("multipart/form-data")
        ? await options.readFormDataWithLimit(options.request, options.maxActionBodySize)
        : await options.readBodyWithLimit(options.request, options.maxActionBodySize);
    } catch (error) {
      if (isRequestBodyTooLarge(error)) {
        return renderFetchActionBodyExceededResponse(options);
      }
      throw error;
    }

    const payloadResponse = await validateServerActionPayload(body);
    if (payloadResponse) {
      clearRejectedActionSideEffects(options.getAndClearPendingCookies);
      options.clearRequestContext();
      return payloadResponse;
    }

    if (action === undefined) {
      let loadedAction: unknown;
      try {
        loadedAction = await options.loadServerAction(options.actionId);
      } catch (error) {
        if (isServerActionNotFoundError(error, options.actionId)) {
          return createActionNotFoundResponse(options.actionId, {
            clearRequestContext: options.clearRequestContext,
            getAndClearPendingCookies: options.getAndClearPendingCookies,
          });
        }

        throw error;
      }

      if (!isAppServerActionFunction(loadedAction)) {
        return createActionNotFoundResponse(options.actionId, {
          clearRequestContext: options.clearRequestContext,
          getAndClearPendingCookies: options.getAndClearPendingCookies,
        });
      }
      action = loadedAction;
    }

    const temporaryReferences = options.createTemporaryReferenceSet();
    const args = await options.decodeReply(body, { temporaryReferences });
    let returnValue: AppServerActionReturnValue;
    let actionRedirect: AppServerActionRedirect | null = null;
    let actionStatus = 200;
    let actionThrew = false;
    const actionWasForwarded = Boolean(options.request.headers.get(ACTION_FORWARDED_HEADER));
    const rootParamsUsage = createRootParamsUsageController();
    const previousHeadersPhase = options.setHeadersAccessPhase("action");
    try {
      try {
        validateServerActionArgs(args);
        const data = await runWithRootParamsUsage(
          { kind: "server-action" },
          () => action.apply(null, args),
          rootParamsUsage,
        );
        returnValue = { ok: true, data };
      } catch (error) {
        actionThrew = true;
        actionRedirect = getActionRedirect(error);
        if (actionRedirect) {
          returnValue = { ok: true, data: undefined };
        } else {
          const httpFallbackStatus = getActionHttpFallbackStatus(error);
          if (httpFallbackStatus !== null) {
            actionStatus = httpFallbackStatus;
            returnValue = { ok: false, data: error };
          } else {
            actionStatus = 500;
            console.error("[vinext] Server action error:", error);
            returnValue = { ok: false, data: options.sanitizeErrorForClient(error) };
          }
        }
      }
    } finally {
      options.setHeadersAccessPhase(previousHeadersPhase);
      if (actionThrew && !actionWasForwarded) rootParamsUsage.transitionToRender();
    }

    // Keep the synchronous next/cache API surface while ensuring the Flight
    // rerender cannot observe data that its action just invalidated.
    await _drainPendingRevalidations();

    if (actionRedirect) {
      const actionPendingCookies = dedupePendingCookies(options.getAndClearPendingCookies());
      const actionDraftCookie = options.getDraftModeCookieHeader();
      const actionRevalidationKind = resolveActionRevalidationKind(
        actionPendingCookies.length > 0 || Boolean(actionDraftCookie),
      );
      const redirectHeaders = new Headers({
        "Content-Type": VINEXT_RSC_CONTENT_TYPE,
        Vary: VINEXT_RSC_VARY_HEADER,
      });
      applyEdgeRuntimeHeader(redirectHeaders, options.isEdgeRuntime);
      mergeActionRedirectSourceHeaders(redirectHeaders, options.sourceConfigHeaders ?? null);
      mergeActionRedirectSourceHeaders(redirectHeaders, options.middlewareHeaders);
      applyRscCompatibilityIdHeader(redirectHeaders);
      // Prefix basePath onto the redirect target. The client-side handler in
      // app-browser-entry reads ACTION_REDIRECT_HEADER and calls
      // window.location.assign/replace verbatim, so the value must already
      // be a basePath-prefixed URL.
      const actionRedirectUrl = applyActionRedirectBasePath(
        actionRedirect.url,
        options.basePath ?? "",
      );
      redirectHeaders.set(ACTION_REDIRECT_HEADER, actionRedirectUrl);
      redirectHeaders.set(ACTION_REDIRECT_TYPE_HEADER, actionRedirect.type);
      redirectHeaders.set(ACTION_REDIRECT_STATUS_HEADER, String(actionRedirect.status));
      for (const cookie of actionPendingCookies) {
        redirectHeaders.append("Set-Cookie", cookie);
      }
      if (actionDraftCookie) redirectHeaders.append("Set-Cookie", actionDraftCookie);
      setActionRevalidatedHeader(redirectHeaders, actionRevalidationKind);

      const redirectTarget = resolveInternalActionRedirectTarget(
        actionRedirectUrl,
        options.request.url,
        options.basePath ?? "",
      );
      if (!redirectTarget) {
        options.clearRequestContext();
        return new Response(null, {
          status: 303,
          headers: withoutRscBodyHeaders(redirectHeaders),
        });
      }

      let targetResponse: Response | null = null;
      try {
        const targetRequest = await createActionRedirectTargetRequest({
          actionMiddlewareHeaders: options.middlewareHeaders,
          actionMiddlewareRequestHeaders: options.middlewareRequestHeaders,
          // Project the action middleware's Set-Cookie mutations (session
          // rotation or deletion) into the internal target request first; the
          // action's own cookies().set() calls land after middleware and win for
          // the same name, matching Next.js' forwarded-cookie ordering.
          pendingCookies: [
            ...(options.sourceConfigHeaders?.getSetCookie() ?? []),
            ...(options.middlewareHeaders?.getSetCookie() ?? []),
            ...actionPendingCookies,
            ...(actionDraftCookie ? [actionDraftCookie] : []),
          ],
          request: options.request,
          sourceConfigHeaders: options.sourceConfigHeaders ?? null,
          url: redirectTarget,
        });
        targetResponse = await dispatchActionRedirectTarget({
          basePath: options.basePath ?? "",
          dispatch: options.dispatchRedirectTargetRequest,
          request: targetRequest,
        });
      } catch (error) {
        console.error("[vinext] Failed to dispatch server action redirect target:", error);
      }
      if (
        !targetResponse ||
        !targetResponse.headers.get("content-type")?.startsWith(VINEXT_RSC_CONTENT_TYPE) ||
        !targetResponse.body
      ) {
        targetResponse?.body?.cancel().catch(() => {});
        options.clearRequestContext();
        return new Response(null, {
          status: 303,
          headers: withoutRscBodyHeaders(redirectHeaders),
        });
      }

      mergeActionRedirectTargetHeaders(redirectHeaders, targetResponse.headers);
      const targetPathname = stripBasePath(redirectTarget.pathname, options.basePath ?? "");
      const targetMatch = options.matchRoute(targetPathname);
      const currentMatch = options.currentRouteMatch;
      const redirectResponseStatus = shouldUseForwardedActionRedirectStatus({
        actionWasForwarded,
        currentPathname: options.cleanPathname,
        currentRoute: currentMatch?.route ?? null,
        resolveRouteRuntime: options.resolveRouteRuntime,
        targetPathname,
        targetRoute: targetMatch?.route ?? null,
      })
        ? 200
        : 303;

      return markAppRscResponseConfigHeadersApplied(
        createServerActionRscResponse(
          targetResponse.body,
          { status: redirectResponseStatus, headers: redirectHeaders },
          options.clearRequestContext,
        ),
      );
    }

    const actionPendingCookies = dedupePendingCookies(options.getAndClearPendingCookies());
    const actionDraftCookie = options.getDraftModeCookieHeader();
    const actionRevalidationKind = resolveActionRevalidationKind(
      actionPendingCookies.length > 0 || Boolean(actionDraftCookie),
    );

    // HTTP access fallbacks always rerender so the page's fallback boundary and
    // metadata are included. Generic errors only rerender after revalidation.
    // Forwarded generic actions never render because this worker does not own
    // the page, but HTTP fallbacks always rerender in Next.js.
    const isHttpFallback = actionStatus === 401 || actionStatus === 403 || actionStatus === 404;
    const shouldSkipPageRendering =
      !isHttpFallback &&
      (actionWasForwarded || actionRevalidationKind === ACTION_DID_NOT_REVALIDATE);
    if (shouldSkipPageRendering) {
      const onRenderError = options.createRscOnErrorHandler(
        options.request,
        options.cleanPathname,
        options.cleanPathname,
      );
      const rscStream = await options.renderToReadableStream(
        { returnValue },
        { temporaryReferences, onError: onRenderError },
      );

      const actionHeaders = new Headers({
        "Content-Type": VINEXT_RSC_CONTENT_TYPE,
        Vary: VINEXT_RSC_VARY_HEADER,
      });
      applyEdgeRuntimeHeader(actionHeaders, options.isEdgeRuntime);
      mergeMiddlewareResponseHeaders(actionHeaders, options.middlewareHeaders);
      applyRscCompatibilityIdHeader(actionHeaders);
      for (const cookie of actionPendingCookies) {
        actionHeaders.append("Set-Cookie", cookie);
      }
      if (actionDraftCookie) actionHeaders.append("Set-Cookie", actionDraftCookie);
      setActionRevalidatedHeader(actionHeaders, actionRevalidationKind);

      return createServerActionRscResponse(
        rscStream,
        {
          status: options.middlewareStatus ?? actionStatus,
          headers: actionHeaders,
        },
        options.clearRequestContext,
      );
    }

    if (!actionThrew) rootParamsUsage.transitionToRender();

    const match = options.currentRouteMatch;
    let element: TElement;
    let errorPattern = match ? match.route.pattern : options.cleanPathname;
    const actionRerenderIsRscRequest = true;
    if (match) {
      const { route: actionRoute, params: actionParams } = match;
      const actionRerenderTarget = await resolveAppPageActionRerenderTarget({
        cleanPathname: options.currentRoutePathname,
        currentParams: actionParams,
        currentRoute: actionRoute,
        findIntercept: options.findIntercept,
        getRouteParamNames: options.getRouteParamNames,
        getSourceRoute: options.getSourceRoute,
        isRscRequest: actionRerenderIsRscRequest,
        toInterceptOpts: options.toInterceptOpts,
      });

      // Use the full navigationParams (not narrowed params) as the merge base so
      // interception-specific extras from a source-route intercept survive the
      // slot param merge — mirroring the dispatch ISR path in app-page-dispatch.ts.
      // The `as` cast is safe because TInterceptOpts is always produced by toInterceptOpts
      // in app-rsc-entry.ts with the same structural shape. Tightening the generic constraint
      // on TInterceptOpts would remove this cast but requires updating all callers.
      const resolvedActionNavigationParams = resolveAppPageNavigationParams(
        actionRerenderTarget.route,
        actionRerenderTarget.navigationParams,
        options.cleanPathname,
        actionRerenderTarget.interceptOpts as Parameters<typeof resolveAppPageNavigationParams>[3],
      );
      // Hydrate the re-render target before reading its page module.
      await options.ensureRouteLoaded?.(actionRerenderTarget.route);
      const actionRerenderDynamicConfig = options.resolveRouteDynamicConfig?.(
        actionRerenderTarget.route,
      );
      const actionRerenderSearchParams = prepareActionPageRerenderContext({
        draftModeCookie: actionDraftCookie,
        draftModeSecret: options.draftModeSecret,
        dynamicConfig: actionRerenderDynamicConfig,
        request: options.request,
        routePattern: actionRerenderTarget.route.pattern,
        searchParams: options.searchParams,
      });
      options.setNavigationContext({
        pathname: options.cleanPathname,
        searchParams: actionRerenderSearchParams,
        params: resolvedActionNavigationParams,
      });
      setCurrentFetchCacheMode(
        options.resolveRouteFetchCacheMode?.(actionRerenderTarget.route) ?? null,
      );
      setCurrentForceDynamicFetchDefault(actionRerenderDynamicConfig === "force-dynamic");
      setCurrentFetchSoftTags(
        buildServerActionPageTags(actionRerenderTarget.route, options.cleanPathname),
      );
      const buildActionRerenderElement = () =>
        options.buildPageElement({
          cleanPathname: options.cleanPathname,
          interceptOpts: actionRerenderTarget.interceptOpts,
          isRscRequest: actionRerenderIsRscRequest,
          mountedSlotsHeader: options.mountedSlotsHeader,
          params: actionRerenderTarget.params,
          request: options.request,
          route: actionRerenderTarget.route,
          searchParams: actionRerenderSearchParams,
          renderMode: APP_RSC_RENDER_MODE_NAVIGATION,
          observeMetadataSearchParamsAccess: actionRerenderDynamicConfig !== "force-static",
          observePageSearchParamsAccess: actionRerenderDynamicConfig !== "force-static",
        });
      element =
        actionWasForwarded && isHttpFallback
          ? await runWithRootParamsUsage({ kind: "route" }, async () =>
              buildActionRerenderElement(),
            )
          : buildActionRerenderElement();
      errorPattern = actionRerenderTarget.route.pattern;
    } else {
      const actionRouteId = options.createPayloadRouteId(options.cleanPathname, null);
      element = options.createNotFoundElement(actionRouteId);
    }

    const onRenderError = options.createRscOnErrorHandler(
      options.request,
      options.cleanPathname,
      errorPattern,
    );
    const renderActionRerender = () =>
      options.renderToReadableStream(
        { root: element, returnValue },
        { temporaryReferences, onError: onRenderError },
      );
    const rscStream = await (actionWasForwarded && isHttpFallback
      ? runWithRootParamsUsage({ kind: "route" }, renderActionRerender)
      : renderActionRerender());

    const actionHeaders = new Headers({
      "Content-Type": VINEXT_RSC_CONTENT_TYPE,
      Vary: VINEXT_RSC_VARY_HEADER,
    });
    applyEdgeRuntimeHeader(actionHeaders, options.isEdgeRuntime);
    mergeMiddlewareResponseHeaders(actionHeaders, options.middlewareHeaders);
    applyRscCompatibilityIdHeader(actionHeaders);
    setActionRevalidatedHeader(actionHeaders, actionRevalidationKind);
    const actionResponse = createServerActionRscResponse(
      rscStream,
      {
        status: options.middlewareStatus ?? actionStatus,
        headers: actionHeaders,
      },
      options.clearRequestContext,
    );
    if (actionPendingCookies.length > 0 || actionDraftCookie) {
      for (const cookie of actionPendingCookies) {
        actionResponse.headers.append("Set-Cookie", cookie);
      }
      if (actionDraftCookie) actionResponse.headers.append("Set-Cookie", actionDraftCookie);
    }
    return actionResponse;
  } catch (error) {
    getAndClearActionRevalidationKind();
    return createServerActionErrorResponse(error, {
      cleanPathname: options.cleanPathname,
      clearRequestContext: options.clearRequestContext,
      getAndClearPendingCookies: options.getAndClearPendingCookies,
      reportRequestError: options.reportRequestError,
      request: options.request,
    });
  }
}
