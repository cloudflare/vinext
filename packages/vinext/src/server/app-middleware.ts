import type { NextI18nConfig } from "../config/next-config.js";
import { isExternalUrl, proxyExternalRequest } from "../config/config-matchers.js";
import { applyMiddlewareRequestHeaders, setHeadersContext } from "vinext/shims/headers";
import { setNavigationContext } from "vinext/shims/navigation";
import { FLIGHT_HEADERS, VINEXT_MW_CTX_HEADER } from "./headers.js";
import { buildRequestHeadersFromMiddlewareResponse } from "../utils/middleware-request-headers.js";
import { mergeMiddlewareResponseHeaders } from "./middleware-response-headers.js";
import { executeMiddleware, type MiddlewareModule } from "./middleware-runtime.js";
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
  module: MiddlewareModule;
  request: Request;
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
      rewritten: boolean;
      search: string | null;
    }
  | {
      kind: "response";
      response: Response;
    };

type ForwardedMiddlewareContext = {
  h?: unknown;
  r?: unknown;
  s?: unknown;
};

// Re-exported from headers.ts for backward compatibility.
export { FLIGHT_HEADERS } from "./headers.js";

const FLIGHT_HEADER_SET = new Set(FLIGHT_HEADERS);

function isForwardedMiddlewareContext(value: unknown): value is ForwardedMiddlewareContext {
  return !!value && typeof value === "object";
}

function requestWithoutFlightHeaders(request: Request): Request {
  let hasFlightHeader = false;
  const headers = new Headers();

  for (const [key, value] of request.headers) {
    if (FLIGHT_HEADER_SET.has(key.toLowerCase())) {
      hasFlightHeader = true;
    } else {
      headers.append(key, value);
    }
  }

  if (!hasFlightHeader) return request;
  const source = request.body ? request.clone() : request;
  return cloneRequestWithHeaders(source, headers);
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
    ? buildRequestHeadersFromMiddlewareResponse(request.headers, middlewareHeaders, {
        preserveCredentialHeaders: true,
      })
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

export async function proxyExternalMiddlewareRewrite(
  request: Request,
  rewriteUrl: string,
  context: AppMiddlewareContext,
): Promise<Response> {
  const proxyRequest = requestWithMiddlewareRequestHeaders(
    request,
    context.requestHeaders ?? context.headers,
  );
  setHeadersContext(null);
  setNavigationContext(null);

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
  const middlewareRequest = requestWithoutFlightHeaders(options.request);
  let cleanPathname = options.cleanPathname;
  let rewritten = false;
  let search: string | null = null;

  if (forwarded.rewriteUrl) {
    try {
      if (isExternalMiddlewareRewrite(forwarded.rewriteUrl, middlewareRequest)) {
        return {
          kind: "response",
          response: await proxyExternalMiddlewareRewrite(
            middlewareRequest,
            forwarded.rewriteUrl,
            options.context,
          ),
        };
      }
      const rewriteParsed = new URL(forwarded.rewriteUrl, middlewareRequest.url);
      cleanPathname = rewriteParsed.pathname;
      rewritten = true;
      search = rewriteParsed.search;
    } catch (e) {
      console.error("[vinext] Failed to apply forwarded middleware rewrite:", e);
      forwarded.applied = false;
    }
  }

  if (!forwarded.applied) {
    const result = await executeMiddleware({
      basePath: options.basePath,
      hadBasePath: options.hadBasePath ?? true,
      filePath: options.filePath,
      i18nConfig: options.i18nConfig,
      isDataRequest: options.isDataRequest,
      isProxy: options.isProxy,
      module: options.module,
      normalizedPathname: cleanPathname,
      request: middlewareRequest,
      trailingSlash: options.trailingSlash,
    });

    if (!result.continue) {
      if (result.redirectUrl) {
        return { kind: "response", response: responseFromMiddlewareRedirect(result) };
      }
      if (result.response) {
        return { kind: "response", response: result.response };
      }
      return { kind: "response", response: internalServerErrorResponse() };
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
        return {
          kind: "response",
          response: await proxyExternalMiddlewareRewrite(
            middlewareRequest,
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

  if (options.context.headers) {
    options.context.requestHeaders = new Headers(options.context.headers);
    applyMiddlewareRequestHeaders(options.context.headers);
    processMiddlewareHeaders(options.context.headers);
  }

  return { kind: "continue", cleanPathname, rewritten, search };
}
