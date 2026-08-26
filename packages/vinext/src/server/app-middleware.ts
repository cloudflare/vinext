import type { NextI18nConfig } from "../config/next-config.js";
import { isExternalUrl } from "../utils/external-url.js";
import { applyMiddlewareRequestHeaders, setHeadersContext } from "vinext/shims/headers";
import { setNavigationContext } from "vinext/shims/navigation";
import { FLIGHT_HEADERS, VINEXT_MW_CTX_HEADER } from "./headers.js";
import { buildRequestHeadersFromMiddlewareResponse } from "../utils/middleware-request-headers.js";
import { mergeMiddlewareResponseHeaders } from "./middleware-response-headers.js";
import {
  executeMiddleware,
  type MiddlewareModule,
  type MiddlewareResult,
} from "./middleware-runtime.js";
import { cloneRequestWithHeaders, processMiddlewareHeaders } from "./request-pipeline.js";
import { internalServerErrorResponse } from "./http-error-responses.js";

export type AppMiddlewareContext = {
  headers: Headers | null;
  requestHeaders: Headers | null;
  status: number | null;
};

export type ApplyAppMiddlewareOptions = {
  basePath?: string;
  cleanPathname: string;
  context: AppMiddlewareContext;
  hadBasePath?: boolean;
  i18nConfig?: NextI18nConfig | null;
  /**
   * Whether the inbound request was recognized as a `_next/data` fetch from
   * trusted URL normalization before internal headers were stripped.
   */
  isDataRequest?: boolean;
  filePath?: string;
  isProxy: boolean;
  /** Request URL for external proxying, retaining internal transport query params. */
  externalRewriteRequest?: Request;
  /** An App Router-created body branch dedicated to middleware. */
  middlewareRequest?: Request;
  module: MiddlewareModule;
  request: Request;
  validateExternalRewriteRequest?: () => Promise<Response | null>;
  /**
   * Forwarded to `executeMiddleware` so the NextRequest exposes a NextURL with
   * the configured trailingSlash policy. This is what makes
   * `NextResponse.redirect(request.nextUrl)` emit a Location that honours
   * `trailingSlash`.
   */
  trailingSlash?: boolean;
};

export type ApplyAppMiddlewareResult =
  | {
      kind: "continue";
      cleanPathname: string;
      /** Present on real middleware results; optional for older generated callers. */
      matched?: boolean;
      /** True when this pathname can match middleware for some request context. */
      pathnameEligible?: boolean;
      rewritten: boolean;
      search: string | null;
    }
  | {
      kind: "response";
      /** Present on real middleware results; optional for older generated callers. */
      matched?: boolean;
      /** True when this pathname can match middleware for some request context. */
      pathnameEligible?: boolean;
      response: Response;
    };

type ForwardedMiddlewareContext = {
  h?: unknown;
  q?: unknown;
  r?: unknown;
  s?: unknown;
};

// Re-exported from headers.ts for backward compatibility.
export { FLIGHT_HEADERS } from "./headers.js";

const FLIGHT_HEADER_SET = new Set(FLIGHT_HEADERS);

function isForwardedMiddlewareContext(value: unknown): value is ForwardedMiddlewareContext {
  return !!value && typeof value === "object";
}

function requestWithoutFlightHeaders(request: Request, isolateBody = false): Request {
  let hasFlightHeader = false;
  const headers = new Headers();

  for (const [key, value] of request.headers) {
    if (FLIGHT_HEADER_SET.has(key.toLowerCase())) {
      hasFlightHeader = true;
    } else {
      headers.append(key, value);
    }
  }

  const source = isolateBody && request.body && !request.bodyUsed ? request.clone() : request;
  if (!hasFlightHeader) return source;
  return cloneRequestWithHeaders(source, headers);
}

function cancelRequestBody(request: Request): void {
  if (request.body && !request.body.locked) {
    void request.body.cancel().catch(() => {});
  }
}

function appendForwardedHeader(headers: Headers, value: unknown): void {
  if (!Array.isArray(value) || value.length < 2) return;
  const key = value[0];
  const headerValue = value[1];
  if (typeof key === "string" && typeof headerValue === "string") {
    headers.append(key, headerValue);
  }
}

function responseFromMiddlewareRedirect(result: {
  redirectStatus?: number;
  redirectUrl?: string;
  response?: Response;
  responseHeaders?: Headers;
}): Response {
  if (result.response) return result.response;

  const headers = new Headers(result.responseHeaders);
  if (result.redirectUrl) {
    headers.set("Location", result.redirectUrl);
  }
  return new Response(null, {
    status: result.redirectStatus ?? 307,
    headers,
  });
}

export function isExternalMiddlewareRewrite(rewriteUrl: string, request: Request): boolean {
  const rewriteParsed = new URL(rewriteUrl, request.url);
  return rewriteParsed.origin !== new URL(request.url).origin;
}

function requestWithMiddlewareRequestHeaders(
  request: Request,
  middlewareHeaders: Headers | null,
): Request {
  const nextHeaders = middlewareHeaders
    ? buildRequestHeadersFromMiddlewareResponse(request.headers, middlewareHeaders)
    : null;
  if (!nextHeaders) return request;

  const init: RequestInit = {
    method: request.method,
    headers: nextHeaders,
    body: request.body,
  };
  if (request.body) {
    Object.defineProperty(init, "duplex", { value: "half", enumerable: true });
  }

  return new Request(request.url, init);
}

function restoreFlightHeaders(request: Request, source: Request): Request {
  const headers = new Headers(request.headers);
  let changed = false;

  for (const name of FLIGHT_HEADERS) {
    const value = source.headers.get(name);
    if (value === null) {
      if (headers.has(name)) {
        headers.delete(name);
        changed = true;
      }
    } else if (headers.get(name) !== value) {
      headers.set(name, value);
      changed = true;
    }
  }

  return changed ? cloneRequestWithHeaders(request, headers) : request;
}

export async function proxyExternalMiddlewareRewrite(
  request: Request,
  rewriteUrl: string,
  context: AppMiddlewareContext,
): Promise<Response> {
  const proxyRequest = restoreFlightHeaders(
    requestWithMiddlewareRequestHeaders(request, context.requestHeaders ?? context.headers),
    request,
  );
  setHeadersContext(null);
  setNavigationContext(null);

  const { proxyExternalRequest } = await import("../config/config-matchers.js");
  const proxyResponse = await proxyExternalRequest(proxyRequest, rewriteUrl);
  const headers = new Headers(proxyResponse.headers);
  processMiddlewareHeaders(headers);

  if (!context.headers) {
    return new Response(proxyResponse.body, {
      status: proxyResponse.status,
      statusText: proxyResponse.statusText,
      headers,
    });
  }

  const middlewareHeaders = new Headers(context.headers);
  processMiddlewareHeaders(middlewareHeaders);
  mergeMiddlewareResponseHeaders(headers, middlewareHeaders);
  return new Response(proxyResponse.body, {
    status: proxyResponse.status,
    statusText: proxyResponse.statusText,
    headers,
  });
}

function validationResponseWithMiddlewareHeaders(
  response: Response,
  context: AppMiddlewareContext,
): Response {
  if (!context.headers) return response;

  const headers = new Headers(response.headers);
  const location = headers.get("location");
  const middlewareHeaders = new Headers(context.headers);
  processMiddlewareHeaders(middlewareHeaders);
  mergeMiddlewareResponseHeaders(headers, middlewareHeaders);
  if (location !== null) headers.set("location", location);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function applyForwardedMiddlewareContext(
  request: Request,
  context: AppMiddlewareContext,
): { applied: boolean; rewriteUrl?: string } {
  if (process.env.NODE_ENV === "production") {
    return { applied: false };
  }

  const header = request.headers.get(VINEXT_MW_CTX_HEADER);
  if (!header) return { applied: false };

  try {
    const data = JSON.parse(header);
    if (!isForwardedMiddlewareContext(data)) return { applied: false };

    if (Array.isArray(data.h) && data.h.length > 0) {
      context.headers = new Headers();
      for (const entry of data.h) {
        appendForwardedHeader(context.headers, entry);
      }
    }
    if (Array.isArray(data.q) && data.q.length > 0) {
      context.requestHeaders = new Headers();
      for (const entry of data.q) {
        appendForwardedHeader(context.requestHeaders, entry);
      }
    }
    if (typeof data.s === "number") {
      context.status = data.s;
    }
    if (typeof data.r === "string" && data.r.length > 0) {
      return { applied: true, rewriteUrl: data.r };
    }
    return { applied: true };
  } catch (e) {
    console.error("[vinext] Failed to parse forwarded middleware context:", e);
    return { applied: false };
  }
}

export async function applyAppMiddleware(
  options: ApplyAppMiddlewareOptions,
): Promise<ApplyAppMiddlewareResult> {
  const forwarded = applyForwardedMiddlewareContext(options.request, options.context);
  let matched = forwarded.applied;
  let pathnameEligible = forwarded.applied;
  let cleanPathname = options.cleanPathname;
  let rewritten = false;
  let search: string | null = null;

  if (forwarded.rewriteUrl) {
    try {
      if (isExternalMiddlewareRewrite(forwarded.rewriteUrl, options.request)) {
        const validationResponse = await options.validateExternalRewriteRequest?.();
        if (validationResponse) {
          if (options.middlewareRequest) cancelRequestBody(options.middlewareRequest);
          return {
            kind: "response",
            matched,
            pathnameEligible,
            response: validationResponseWithMiddlewareHeaders(validationResponse, options.context),
          };
        }
        if (options.middlewareRequest) cancelRequestBody(options.middlewareRequest);
        const externalRequest = options.externalRewriteRequest ?? options.request;
        return {
          kind: "response",
          matched,
          pathnameEligible,
          response: await proxyExternalMiddlewareRewrite(
            externalRequest,
            forwarded.rewriteUrl,
            options.context,
          ),
        };
      }
      const rewriteParsed = new URL(forwarded.rewriteUrl, options.request.url);
      cleanPathname = rewriteParsed.pathname;
      rewritten = true;
      search = rewriteParsed.search;
    } catch (e) {
      console.error("[vinext] Failed to apply forwarded middleware rewrite:", e);
      forwarded.applied = false;
    }
  }

  if (!forwarded.applied) {
    // App Router may have created the one genuine middleware/downstream branch
    // before URL normalization. Other callers branch here. Either way,
    // executeMiddleware takes ownership instead of teeing a second time.
    const middlewareRequest = requestWithoutFlightHeaders(
      options.middlewareRequest ?? options.request,
      options.middlewareRequest === undefined,
    );
    let result: MiddlewareResult;
    try {
      result = await executeMiddleware({
        basePath: options.basePath,
        hadBasePath: options.hadBasePath ?? true,
        filePath: options.filePath,
        i18nConfig: options.i18nConfig,
        isDataRequest: options.isDataRequest,
        isProxy: options.isProxy,
        module: options.module,
        normalizedPathname: cleanPathname,
        onMatch() {
          matched = true;
        },
        onPathMatch() {
          pathnameEligible = true;
        },
        requestBodyAlreadyIsolated: true,
        request: middlewareRequest,
        trailingSlash: options.trailingSlash,
      });
    } finally {
      // Matcher misses and validation failures return before executeMiddleware
      // transfers this branch into NextRequest. Once transferred it is locked,
      // so this is a no-op and executeMiddleware owns the cancellation instead.
      cancelRequestBody(middlewareRequest);
    }

    if (!result.continue) {
      cancelRequestBody(options.request);
      if (result.redirectUrl) {
        return {
          kind: "response",
          matched,
          pathnameEligible,
          response: responseFromMiddlewareRedirect(result),
        };
      }
      if (result.response) {
        return { kind: "response", matched, pathnameEligible, response: result.response };
      }
      return {
        kind: "response",
        matched,
        pathnameEligible,
        response: internalServerErrorResponse(),
      };
    }

    if (result.responseHeaders) {
      options.context.headers = new Headers(result.responseHeaders);
    }

    if (result.status !== undefined) {
      options.context.status = result.status;
    }

    if (result.rewriteUrl) {
      if (result.rewriteStatus !== undefined) {
        options.context.status = result.rewriteStatus;
      }
      if (isExternalUrl(result.rewriteUrl)) {
        const validationResponse = await options.validateExternalRewriteRequest?.();
        if (validationResponse) {
          return {
            kind: "response",
            matched,
            pathnameEligible,
            response: validationResponseWithMiddlewareHeaders(validationResponse, options.context),
          };
        }
        const externalRequest = options.externalRewriteRequest ?? options.request;
        return {
          kind: "response",
          matched,
          pathnameEligible,
          response: await proxyExternalMiddlewareRewrite(
            externalRequest,
            result.rewriteUrl,
            options.context,
          ),
        };
      }
      const rewriteParsed = new URL(result.rewriteUrl, middlewareRequest.url);
      cleanPathname = rewriteParsed.pathname;
      rewritten = true;
      search = rewriteParsed.search;
    }
  }

  if (forwarded.applied && options.middlewareRequest) {
    cancelRequestBody(options.middlewareRequest);
  }

  if (options.context.headers || options.context.requestHeaders) {
    options.context.requestHeaders ??= new Headers(options.context.headers!);
    applyMiddlewareRequestHeaders(options.context.requestHeaders);
  }
  if (options.context.headers) {
    processMiddlewareHeaders(options.context.headers);
  }

  return {
    kind: "continue",
    cleanPathname,
    matched,
    pathnameEligible,
    rewritten,
    search,
  };
}
