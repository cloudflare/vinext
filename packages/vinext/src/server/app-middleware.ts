import type { NextI18nConfig } from "../config/next-config.js";
import { isExternalUrl, proxyExternalRequest } from "../config/config-matchers.js";
import { applyMiddlewareRequestHeaders, setHeadersContext } from "vinext/shims/headers";
import { setNavigationContext } from "vinext/shims/navigation";
import { buildRequestHeadersFromMiddlewareResponse } from "./middleware-request-headers.js";
import { mergeMiddlewareResponseHeaders } from "./middleware-response-headers.js";
import { executeMiddleware, type MiddlewareModule } from "./middleware-runtime.js";
import { processMiddlewareHeaders } from "./request-pipeline.js";

export type AppMiddlewareContext = {
  headers: Headers | null;
  requestHeaders: Headers | null;
  status: number | null;
};

export type ApplyAppMiddlewareOptions = {
  basePath?: string;
  cleanPathname: string;
  context: AppMiddlewareContext;
  i18nConfig?: NextI18nConfig | null;
  isProxy: boolean;
  module: MiddlewareModule;
  request: Request;
};

export type ApplyAppMiddlewareResult =
  | {
      kind: "continue";
      cleanPathname: string;
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

function isForwardedMiddlewareContext(value: unknown): value is ForwardedMiddlewareContext {
  return !!value && typeof value === "object";
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
  if (!context.headers) return proxyResponse;

  const middlewareHeaders = new Headers(context.headers);
  processMiddlewareHeaders(middlewareHeaders);
  const headers = new Headers(proxyResponse.headers);
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

  const header = request.headers.get("x-vinext-mw-ctx");
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
  let cleanPathname = options.cleanPathname;
  let search: string | null = null;

  if (forwarded.rewriteUrl) {
    try {
      if (isExternalMiddlewareRewrite(forwarded.rewriteUrl, options.request)) {
        return {
          kind: "response",
          response: await proxyExternalMiddlewareRewrite(
            options.request,
            forwarded.rewriteUrl,
            options.context,
          ),
        };
      }
      const rewriteParsed = new URL(forwarded.rewriteUrl, options.request.url);
      cleanPathname = rewriteParsed.pathname;
      search = rewriteParsed.search;
    } catch (e) {
      console.error("[vinext] Failed to apply forwarded middleware rewrite:", e);
      forwarded.applied = false;
    }
  }

  if (!forwarded.applied) {
    const result = await executeMiddleware({
      basePath: options.basePath,
      i18nConfig: options.i18nConfig,
      isProxy: options.isProxy,
      module: options.module,
      normalizedPathname: cleanPathname,
      request: options.request,
    });

    if (!result.continue) {
      if (result.redirectUrl) {
        return { kind: "response", response: responseFromMiddlewareRedirect(result) };
      }
      if (result.response) {
        return { kind: "response", response: result.response };
      }
      return { kind: "response", response: new Response("Internal Server Error", { status: 500 }) };
    }

    if (result.responseHeaders) {
      options.context.headers = new Headers(result.responseHeaders);
    }

    if (result.rewriteUrl) {
      if (result.rewriteStatus !== undefined) {
        options.context.status = result.rewriteStatus;
      }
      if (isExternalUrl(result.rewriteUrl)) {
        return {
          kind: "response",
          response: await proxyExternalMiddlewareRewrite(
            options.request,
            result.rewriteUrl,
            options.context,
          ),
        };
      }
      const rewriteParsed = new URL(result.rewriteUrl, options.request.url);
      cleanPathname = rewriteParsed.pathname;
      search = rewriteParsed.search;
    }
  }

  if (options.context.headers) {
    options.context.requestHeaders = new Headers(options.context.headers);
    applyMiddlewareRequestHeaders(options.context.headers);
    processMiddlewareHeaders(options.context.headers);
  }

  return { kind: "continue", cleanPathname, search };
}
