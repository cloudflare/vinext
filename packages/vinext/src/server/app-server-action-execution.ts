import type { HeadersAccessPhase } from "vinext/shims/headers";
import { type FetchCacheMode, setCurrentFetchCacheMode } from "vinext/shims/fetch-cache";
import { VINEXT_RSC_VARY_HEADER } from "./app-rsc-cache-busting.js";
import { resolveAppPageActionRerenderTarget } from "./app-page-request.js";
import { mergeMiddlewareResponseHeaders } from "./middleware-response-headers.js";
import {
  getNextErrorDigest,
  parseNextHttpErrorDigest,
  parseNextRedirectDigest,
} from "./next-error-digest.js";
import { validateCsrfOrigin, validateServerActionPayload } from "./request-pipeline.js";
import { readStreamAsTextWithLimit } from "../utils/text-stream.js";
import {
  createServerActionNotFoundResponse,
  getServerActionNotFoundMessage,
  isServerActionNotFoundError,
} from "./server-action-not-found.js";
import { internalServerErrorResponse, payloadTooLargeResponse } from "./http-error-responses.js";

type AppPageParams = Record<string, string | string[]>;

type AppServerActionErrorReporter = (
  error: Error,
  request: { path: string; method: string; headers: Record<string, string> },
  route: { routerKind: "App Router"; routePath: string; routeType: "action" },
) => void;

type AppServerActionDecoder = (body: FormData) => Promise<unknown>;

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
  pattern: string;
};

type AppServerActionMatch<TRoute extends AppServerActionRoute> = {
  params: AppPageParams;
  route: TRoute;
};

type AppServerActionIntercept<TPage = unknown> = {
  matchedParams: AppPageParams;
  page: TPage;
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
};

type AppServerActionRscModel<TElement> = {
  returnValue: AppServerActionReturnValue;
  root: TElement;
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
  cleanPathname: string;
  clearRequestContext: () => void;
  contentType: string;
  decodeAction: AppServerActionDecoder;
  getAndClearPendingCookies: () => string[];
  getDraftModeCookieHeader: () => string | null | undefined;
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
  buildPageElement: (
    options: BuildServerActionPageElementOptions<TRoute, TInterceptOpts>,
  ) => TElement;
  cleanPathname: string;
  clearRequestContext: () => void;
  contentType: string;
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
  findIntercept: (pathname: string) => AppServerActionIntercept<TPage> | null;
  getAndClearPendingCookies: () => string[];
  getDraftModeCookieHeader: () => string | null | undefined;
  getRouteParamNames: (route: TRoute) => readonly string[];
  getSourceRoute: (sourceRouteIndex: number) => TRoute | undefined;
  isRscRequest: boolean;
  loadServerAction: (actionId: string) => Promise<unknown>;
  matchRoute: (pathname: string) => AppServerActionMatch<TRoute> | null;
  maxActionBodySize: number;
  middlewareHeaders: Headers | null;
  middlewareStatus: number | null | undefined;
  mountedSlotsHeader: string | null;
  readBodyWithLimit: ReadBodyWithLimit;
  readFormDataWithLimit: ReadFormDataWithLimit;
  renderToReadableStream: (
    model: AppServerActionRscModel<TElement>,
    options: RenderServerActionRscStreamOptions<TTemporaryReferences>,
  ) => BodyInit | null | Promise<BodyInit | null>;
  reportRequestError: AppServerActionErrorReporter;
  resolveRouteFetchCacheMode?: (route: TRoute) => FetchCacheMode | null;
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

type ActionControlResponse =
  | {
      kind: "redirect";
      url: string;
    }
  | {
      kind: "status";
      statusCode: number;
    };

function isRequestBodyTooLarge(error: unknown): boolean {
  return error instanceof Error && error.message === "Request body too large";
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
      await reader.cancel();
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

function getActionControlResponse(error: unknown): ActionControlResponse | null {
  const digest = getNextErrorDigest(error);
  if (!digest) return null;

  const redirect = parseNextRedirectDigest(digest);
  if (redirect) {
    return {
      kind: "redirect",
      url: redirect.url,
    };
  }

  const httpError = parseNextHttpErrorDigest(digest);
  if (httpError) {
    if (!Number.isInteger(httpError.status)) {
      return null;
    }

    return {
      kind: "status",
      statusCode: httpError.status,
    };
  }

  return null;
}

function getActionRedirect(error: unknown): AppServerActionRedirect | null {
  const digest = getNextErrorDigest(error);
  if (!digest) return null;

  const redirect = parseNextRedirectDigest(digest);
  if (!redirect) return null;

  return {
    status: redirect.status,
    type: redirect.type,
    url: redirect.url,
  };
}

function isActionHttpFallback(error: unknown): boolean {
  const digest = getNextErrorDigest(error);
  return digest !== null && parseNextHttpErrorDigest(digest) !== null;
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
): Promise<Response | null> {
  if (!isProgressiveServerActionRequest(options.request, options.contentType, options.actionId)) {
    return null;
  }

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
      options.clearRequestContext();
      return payloadResponse;
    }

    const action = await options.decodeAction(body);
    if (typeof action !== "function") {
      return null;
    }

    let actionControlResponse: ActionControlResponse | null = null;
    const previousHeadersPhase = options.setHeadersAccessPhase("action");
    try {
      await action();
    } catch (error) {
      actionControlResponse = getActionControlResponse(error);
      if (!actionControlResponse) {
        throw error;
      }
    } finally {
      options.setHeadersAccessPhase(previousHeadersPhase);
    }

    if (!actionControlResponse) {
      // Next.js decodes form state and re-renders after a successful MPA action.
      // vinext currently supports the redirect/error status cases; successful
      // non-redirect actions intentionally fall through to the page render.
      return null;
    }

    const actionPendingCookies = options.getAndClearPendingCookies();
    const actionDraftCookie = options.getDraftModeCookieHeader();
    options.clearRequestContext();

    const headers = new Headers();
    if (actionControlResponse.kind === "redirect") {
      headers.set("Location", new URL(actionControlResponse.url, options.request.url).toString());
    }
    mergeMiddlewareResponseHeaders(headers, options.middlewareHeaders);
    for (const cookie of actionPendingCookies) {
      headers.append("Set-Cookie", cookie);
    }
    if (actionDraftCookie) {
      headers.append("Set-Cookie", actionDraftCookie);
    }

    return new Response(null, {
      status: actionControlResponse.kind === "redirect" ? 303 : actionControlResponse.statusCode,
      headers,
    });
  } catch (error) {
    if (isServerActionNotFoundError(error, null)) {
      return createActionNotFoundResponse(null, {
        clearRequestContext: options.clearRequestContext,
        getAndClearPendingCookies: options.getAndClearPendingCookies,
      });
    }

    options.getAndClearPendingCookies();
    // Next.js rethrows generic MPA action errors into its page render path.
    // vinext does not yet implement that form-state render path, so unexpected
    // action failures remain request failures here.
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
    options.clearRequestContext();
    return payloadTooLargeResponse();
  }

  try {
    let body: string | FormData;
    try {
      body = options.contentType.startsWith("multipart/form-data")
        ? await options.readFormDataWithLimit(options.request, options.maxActionBodySize)
        : await options.readBodyWithLimit(options.request, options.maxActionBodySize);
    } catch (error) {
      if (isRequestBodyTooLarge(error)) {
        options.clearRequestContext();
        return payloadTooLargeResponse();
      }
      throw error;
    }

    const payloadResponse = await validateServerActionPayload(body);
    if (payloadResponse) {
      options.clearRequestContext();
      return payloadResponse;
    }

    let action: unknown;
    try {
      action = await options.loadServerAction(options.actionId);
    } catch (error) {
      if (isServerActionNotFoundError(error, options.actionId)) {
        return createActionNotFoundResponse(options.actionId, {
          clearRequestContext: options.clearRequestContext,
          getAndClearPendingCookies: options.getAndClearPendingCookies,
        });
      }

      throw error;
    }

    if (!isAppServerActionFunction(action)) {
      return createActionNotFoundResponse(options.actionId, {
        clearRequestContext: options.clearRequestContext,
        getAndClearPendingCookies: options.getAndClearPendingCookies,
      });
    }

    const temporaryReferences = options.createTemporaryReferenceSet();
    const args = await options.decodeReply(body, { temporaryReferences });
    let returnValue: AppServerActionReturnValue;
    let actionRedirect: AppServerActionRedirect | null = null;
    const previousHeadersPhase = options.setHeadersAccessPhase("action");
    try {
      try {
        const data = await action.apply(null, args);
        returnValue = { ok: true, data };
      } catch (error) {
        actionRedirect = getActionRedirect(error);
        if (actionRedirect) {
          returnValue = { ok: true, data: undefined };
        } else if (isActionHttpFallback(error)) {
          returnValue = { ok: false, data: error };
        } else {
          console.error("[vinext] Server action error:", error);
          returnValue = { ok: false, data: options.sanitizeErrorForClient(error) };
        }
      }
    } finally {
      options.setHeadersAccessPhase(previousHeadersPhase);
    }

    if (actionRedirect) {
      const actionPendingCookies = options.getAndClearPendingCookies();
      const actionDraftCookie = options.getDraftModeCookieHeader();
      options.clearRequestContext();
      const redirectHeaders = new Headers({
        "Content-Type": "text/x-component; charset=utf-8",
        Vary: VINEXT_RSC_VARY_HEADER,
      });
      mergeMiddlewareResponseHeaders(redirectHeaders, options.middlewareHeaders);
      redirectHeaders.set("x-action-redirect", actionRedirect.url);
      redirectHeaders.set("x-action-redirect-type", actionRedirect.type);
      redirectHeaders.set("x-action-redirect-status", String(actionRedirect.status));
      for (const cookie of actionPendingCookies) {
        redirectHeaders.append("Set-Cookie", cookie);
      }
      if (actionDraftCookie) redirectHeaders.append("Set-Cookie", actionDraftCookie);
      return new Response("", { status: 200, headers: redirectHeaders });
    }

    const match = options.matchRoute(options.cleanPathname);
    let element: TElement;
    let errorPattern = match ? match.route.pattern : options.cleanPathname;
    if (match) {
      const { route: actionRoute, params: actionParams } = match;
      const actionRerenderTarget = resolveAppPageActionRerenderTarget({
        cleanPathname: options.cleanPathname,
        currentParams: actionParams,
        currentRoute: actionRoute,
        findIntercept: options.findIntercept,
        getRouteParamNames: options.getRouteParamNames,
        getSourceRoute: options.getSourceRoute,
        isRscRequest: options.isRscRequest,
        toInterceptOpts: options.toInterceptOpts,
      });

      options.setNavigationContext({
        pathname: options.cleanPathname,
        searchParams: options.searchParams,
        params: actionRerenderTarget.navigationParams,
      });
      setCurrentFetchCacheMode(
        options.resolveRouteFetchCacheMode?.(actionRerenderTarget.route) ?? null,
      );
      element = options.buildPageElement({
        cleanPathname: options.cleanPathname,
        interceptOpts: actionRerenderTarget.interceptOpts,
        isRscRequest: options.isRscRequest,
        mountedSlotsHeader: options.mountedSlotsHeader,
        params: actionRerenderTarget.params,
        request: options.request,
        route: actionRerenderTarget.route,
        searchParams: options.searchParams,
      });
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
    const rscStream = await options.renderToReadableStream(
      { root: element, returnValue },
      { temporaryReferences, onError: onRenderError },
    );

    const actionPendingCookies = options.getAndClearPendingCookies();
    const actionDraftCookie = options.getDraftModeCookieHeader();

    const actionHeaders = new Headers({
      "Content-Type": "text/x-component; charset=utf-8",
      Vary: VINEXT_RSC_VARY_HEADER,
    });
    mergeMiddlewareResponseHeaders(actionHeaders, options.middlewareHeaders);
    const actionResponse = new Response(rscStream, {
      status: options.middlewareStatus ?? 200,
      headers: actionHeaders,
    });
    if (actionPendingCookies.length > 0 || actionDraftCookie) {
      for (const cookie of actionPendingCookies) {
        actionResponse.headers.append("Set-Cookie", cookie);
      }
      if (actionDraftCookie) actionResponse.headers.append("Set-Cookie", actionDraftCookie);
    }
    return actionResponse;
  } catch (error) {
    return createServerActionErrorResponse(error, {
      cleanPathname: options.cleanPathname,
      clearRequestContext: options.clearRequestContext,
      getAndClearPendingCookies: options.getAndClearPendingCookies,
      reportRequestError: options.reportRequestError,
      request: options.request,
    });
  }
}
