import { RequestCookies, ResponseCookies } from "vinext/shims/internal/cookies";
import { patternToNextFormat } from "../routing/route-validation.js";
import { buildRequestHeadersFromMiddlewareResponse } from "../utils/middleware-request-headers.js";
import type { AppMiddlewareContext } from "./app-middleware.js";
import { getSetCookieName } from "./cookie-utils.js";
import {
  ACTION_FORWARDED_HEADER,
  ACTION_REDIRECT_HEADER,
  NEXTJS_ACTION_NOT_FOUND_HEADER,
} from "./headers.js";
import { mergeMiddlewareResponseHeaders } from "./middleware-response-headers.js";
import {
  createServerActionNotFoundResponse,
  getServerActionNotFoundMessage,
} from "./server-action-not-found.js";
import {
  attachRequestCfMetadata,
  processMiddlewareHeaders,
  validateCsrfOrigin,
} from "./request-pipeline.js";

const ACTION_FORWARD_FORBIDDEN_HEADERS = new Set([
  "accept-encoding",
  "keepalive",
  "keep-alive",
  "content-encoding",
  "transfer-encoding",
  "connection",
  "expect",
  "content-length",
  "set-cookie",
]);

type ActionOwnerManifest = Readonly<Record<string, readonly string[]>>;

type ForwardServerActionOptions = {
  actionId: string;
  actionOwners: ActionOwnerManifest | null;
  allowedOrigins: string[];
  basePath: string;
  clearRequestContext: () => void;
  currentRoutePattern: string | null;
  dispatch: (request: Request) => Promise<Response>;
  middlewareContext: AppMiddlewareContext;
  request: Request;
};

function deletesCookie(setCookie: string, now: number): boolean {
  let maxAge: number | null = null;
  let expiresAt: number | null = null;
  for (const attribute of setCookie.split(";").slice(1)) {
    const equalsIndex = attribute.indexOf("=");
    if (equalsIndex === -1) continue;
    const name = attribute.slice(0, equalsIndex).trim().toLowerCase();
    const value = attribute.slice(equalsIndex + 1).trim();
    if (name === "max-age") {
      const parsedMaxAge = Number(value);
      if (Number.isFinite(parsedMaxAge)) maxAge = parsedMaxAge;
    }
    if (name === "expires") {
      const parsedExpiresAt = Date.parse(value);
      if (Number.isFinite(parsedExpiresAt)) expiresAt = parsedExpiresAt;
    }
  }
  return maxAge !== null ? maxAge <= 0 : expiresAt !== null && expiresAt <= now;
}

function mergeActionForwardCookies(requestHeaders: Headers, responseHeaders: Headers): void {
  const requestCookies = new RequestCookies(requestHeaders);
  const now = Date.now();
  for (const setCookie of responseHeaders.getSetCookie()) {
    const name = getSetCookieName(setCookie);
    if (!name) continue;
    if (deletesCookie(setCookie, now)) {
      requestCookies.delete(name);
      continue;
    }
    const [cookie] = new ResponseCookies(new Headers({ "set-cookie": setCookie })).getAll();
    if (cookie) requestCookies.set(cookie);
  }
  requestHeaders.set("cookie", requestCookies.toString());
}

function buildActionForwardHeaders(
  request: Request,
  middlewareContext: AppMiddlewareContext,
): Headers {
  const middlewareRequestHeaders = middlewareContext.requestHeaders ?? middlewareContext.headers;
  const headers = middlewareRequestHeaders
    ? (buildRequestHeadersFromMiddlewareResponse(request.headers, middlewareRequestHeaders) ??
      new Headers(request.headers))
    : new Headers(request.headers);

  for (const [key, value] of middlewareContext.headers ?? []) {
    headers.set(key, value);
  }
  if (middlewareContext.headers) {
    mergeActionForwardCookies(headers, middlewareContext.headers);
  }
  for (const key of ACTION_FORWARD_FORBIDDEN_HEADERS) {
    headers.delete(key);
  }
  return headers;
}

function filterActionForwardResponse(
  response: Response,
  sourceMiddlewareHeaders: Headers | null,
  sourceMiddlewareStatus: number | null,
): Response {
  const headers = new Headers();
  if (sourceMiddlewareHeaders) {
    const processedSourceHeaders = new Headers(sourceMiddlewareHeaders);
    processMiddlewareHeaders(processedSourceHeaders);
    mergeMiddlewareResponseHeaders(headers, processedSourceHeaders);
  }
  for (const [key, value] of response.headers) {
    if (!ACTION_FORWARD_FORBIDDEN_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  }
  for (const setCookie of response.headers.getSetCookie()) {
    headers.append("set-cookie", setCookie);
  }
  const preserveResponseStatus =
    response.headers.get(NEXTJS_ACTION_NOT_FOUND_HEADER) === "1" ||
    response.headers.has(ACTION_REDIRECT_HEADER);
  return new Response(response.body, {
    headers,
    status: preserveResponseStatus ? response.status : (sourceMiddlewareStatus ?? response.status),
    statusText: response.statusText,
  });
}

function emptyActionForwardResponse(middlewareContext: AppMiddlewareContext): Response {
  const headers = new Headers(middlewareContext.headers ?? undefined);
  processMiddlewareHeaders(headers);
  headers.set("content-type", "application/json");
  return new Response("{}", { headers, status: middlewareContext.status ?? 200 });
}

function actionOwnerPatterns(
  actionOwners: ActionOwnerManifest,
  actionId: string,
): readonly string[] | undefined {
  if (Object.hasOwn(actionOwners, actionId)) return actionOwners[actionId];
  const moduleId = actionId.split("#", 1)[0]!;
  return Object.hasOwn(actionOwners, moduleId) ? actionOwners[moduleId] : undefined;
}

export function areServerActionsOwnedByRoute(
  actionOwners: ActionOwnerManifest | null,
  actionIds: readonly string[],
  currentRoutePattern: string | null,
): boolean {
  if (!actionOwners) return true;
  return actionIds.every((actionId) => {
    const ownerPatterns = actionOwnerPatterns(actionOwners, actionId);
    return (
      ownerPatterns?.includes("*") === true ||
      (currentRoutePattern !== null && ownerPatterns?.includes(currentRoutePattern) === true)
    );
  });
}

export async function forwardServerActionIfNeeded(
  options: ForwardServerActionOptions,
): Promise<Response | null> {
  if (!options.actionOwners) return null;

  const csrfResponse = validateCsrfOrigin(options.request, options.allowedOrigins);
  if (csrfResponse) return csrfResponse;

  const ownerPatterns = actionOwnerPatterns(options.actionOwners, options.actionId);
  if (ownerPatterns?.includes("*")) return null;
  if (
    ownerPatterns &&
    options.currentRoutePattern &&
    ownerPatterns.includes(options.currentRoutePattern)
  ) {
    return null;
  }

  const ownerPath = ownerPatterns?.[0];
  if (!ownerPath) {
    console.warn(getServerActionNotFoundMessage(options.actionId));
    options.clearRequestContext();
    return filterActionForwardResponse(
      createServerActionNotFoundResponse(),
      options.middlewareContext.headers,
      options.middlewareContext.status,
    );
  }
  if (options.request.headers.get(ACTION_FORWARDED_HEADER)) {
    options.clearRequestContext();
    return emptyActionForwardResponse(options.middlewareContext);
  }

  const forwardUrl = new URL(options.request.url);
  forwardUrl.pathname =
    options.basePath + (ownerPath === "/" ? "" : patternToNextFormat(ownerPath));
  // Match Next.js createForwardedActionResponse(): forwarding targets only the
  // owner worker pathname, not the caller's query string.
  forwardUrl.search = "";
  const forwardRequest = attachRequestCfMetadata(
    new Request(forwardUrl, {
      body: options.request.body,
      duplex: "half",
      headers: buildActionForwardHeaders(options.request, options.middlewareContext),
      method: "POST",
    } as RequestInit & { duplex: "half" }),
    options.request,
  );

  let forwardResponse: Response;
  try {
    forwardResponse = await options.dispatch(forwardRequest);
  } catch (error) {
    console.error("[vinext] Failed to forward server action:", error);
    options.clearRequestContext();
    return emptyActionForwardResponse(options.middlewareContext);
  }

  if (
    forwardResponse.headers.get(NEXTJS_ACTION_NOT_FOUND_HEADER) === "1" ||
    forwardResponse.headers.has(ACTION_REDIRECT_HEADER) ||
    forwardResponse.headers.get("content-type")?.startsWith("text/x-component")
  ) {
    return filterActionForwardResponse(
      forwardResponse,
      options.middlewareContext.headers,
      options.middlewareContext.status,
    );
  }
  void forwardResponse.body?.cancel().catch(() => {});
  return emptyActionForwardResponse(options.middlewareContext);
}
