import type { NextI18nConfig } from "../config/next-config.js";
import { normalizePathnameForRouteMatchStrict } from "../routing/utils.js";
import {
  getRequestExecutionContext,
  runWithExecutionContext,
  type ExecutionContextLike,
} from "vinext/shims/request-context";
import { NextFetchEvent, NextRequest } from "vinext/shims/server";
import { normalizePath } from "./normalize-path.js";
import { MatcherConfig, matchesMiddleware } from "./middleware-matcher.js";
import { shouldKeepMiddlewareHeader } from "./middleware-request-headers.js";
import { processMiddlewareHeaders } from "./request-pipeline.js";

export type MiddlewareModule = Record<string, unknown>;

export type MiddlewareResult = {
  continue: boolean;
  redirectUrl?: string;
  redirectStatus?: number;
  rewriteUrl?: string;
  rewriteStatus?: number;
  responseHeaders?: Headers;
  response?: Response;
  waitUntilPromises?: Promise<unknown>[];
};

type MiddlewareHandler = (
  request: NextRequest,
  event: NextFetchEvent,
) => Response | undefined | void | Promise<Response | undefined | void>;

type MiddlewareConfigExport = {
  matcher?: MatcherConfig;
};

type ExecuteMiddlewareOptions = {
  basePath?: string;
  filePath?: string;
  i18nConfig?: NextI18nConfig | null;
  includeErrorDetails?: boolean;
  isProxy: boolean;
  module: MiddlewareModule;
  normalizedPathname?: string;
  request: Request;
};

type RunGeneratedMiddlewareOptions = ExecuteMiddlewareOptions & {
  ctx?: ExecutionContextLike;
};

function isMiddlewareHandler(value: unknown): value is MiddlewareHandler {
  return typeof value === "function";
}

function isMiddlewareConfigExport(value: unknown): value is MiddlewareConfigExport {
  return !!value && typeof value === "object";
}

function middlewareFileLabel(isProxy: boolean): string {
  return isProxy ? "Proxy" : "Middleware";
}

function middlewareExpectedExport(isProxy: boolean): string {
  return isProxy ? "proxy" : "middleware";
}

export function resolveMiddlewareModuleHandler(
  mod: MiddlewareModule,
  options: { filePath?: string; isProxy: boolean },
): MiddlewareHandler {
  const handler = options.isProxy ? (mod.proxy ?? mod.default) : (mod.middleware ?? mod.default);
  if (isMiddlewareHandler(handler)) return handler;

  const fileLabel = middlewareFileLabel(options.isProxy);
  const expectedExport = middlewareExpectedExport(options.isProxy);
  const fileSuffix = options.filePath ? ` "${options.filePath}"` : "";
  throw new Error(
    `The ${fileLabel} file${fileSuffix} must export a function named \`${expectedExport}\` or a \`default\` function.`,
  );
}

function middlewareMatcher(mod: MiddlewareModule): MatcherConfig | undefined {
  const config = mod.config;
  if (!isMiddlewareConfigExport(config)) return undefined;
  return config.matcher;
}

function stripMiddlewareHeadersFromResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  processMiddlewareHeaders(headers);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function collectMiddlewareHeaders(response: Response): Headers {
  const responseHeaders = new Headers();
  for (const [key, value] of response.headers) {
    if (!key.startsWith("x-middleware-") || shouldKeepMiddlewareHeader(key)) {
      responseHeaders.append(key, value);
    }
  }
  return responseHeaders;
}

function drainFetchEvent(fetchEvent: NextFetchEvent): Promise<unknown>[] {
  const waitUntilPromises = fetchEvent.waitUntilPromises;
  const drained = fetchEvent.drainWaitUntil();
  const executionContext = getRequestExecutionContext();
  if (executionContext) {
    executionContext.waitUntil(drained);
  } else {
    void drained;
  }
  return waitUntilPromises;
}

function resolveMiddlewarePathname(request: Request): string | Response {
  const url = new URL(request.url);
  try {
    return normalizePath(normalizePathnameForRouteMatchStrict(url.pathname));
  } catch {
    return new Response("Bad Request", { status: 400 });
  }
}

function createNextRequest(
  request: Request,
  normalizedPathname: string,
  i18nConfig?: NextI18nConfig | null,
  basePath?: string,
): NextRequest {
  const url = new URL(request.url);
  let mwRequest = request;
  if (normalizedPathname !== url.pathname) {
    const mwUrl = new URL(url);
    mwUrl.pathname = normalizedPathname;
    mwRequest = new Request(mwUrl, request);
  }

  const nextConfig =
    basePath || i18nConfig
      ? { basePath: basePath ?? "", i18n: i18nConfig ?? undefined }
      : undefined;

  return mwRequest instanceof NextRequest
    ? mwRequest
    : new NextRequest(mwRequest, nextConfig ? { nextConfig } : undefined);
}

export async function executeMiddleware(
  options: ExecuteMiddlewareOptions,
): Promise<MiddlewareResult> {
  const middlewareFn = resolveMiddlewareModuleHandler(options.module, {
    filePath: options.filePath,
    isProxy: options.isProxy,
  });
  const normalizedPathname =
    options.normalizedPathname ?? resolveMiddlewarePathname(options.request);
  if (normalizedPathname instanceof Response) {
    return { continue: false, response: normalizedPathname };
  }

  if (
    !matchesMiddleware(
      normalizedPathname,
      middlewareMatcher(options.module),
      options.request,
      options.i18nConfig,
    )
  ) {
    return { continue: true };
  }

  const nextRequest = createNextRequest(
    options.request,
    normalizedPathname,
    options.i18nConfig,
    options.basePath,
  );
  const fetchEvent = new NextFetchEvent({ page: normalizedPathname });

  let response: Response | undefined | void;
  try {
    response = await middlewareFn(nextRequest, fetchEvent);
  } catch (e) {
    console.error("[vinext] Middleware error:", e);
    const waitUntilPromises = drainFetchEvent(fetchEvent);
    const message = options.includeErrorDetails
      ? "Middleware Error: " + (e instanceof Error ? e.message : String(e))
      : "Internal Server Error";
    return {
      continue: false,
      response: new Response(message, { status: 500 }),
      waitUntilPromises,
    };
  }

  const waitUntilPromises = drainFetchEvent(fetchEvent);

  if (!response) {
    return { continue: true, waitUntilPromises };
  }

  if (response.headers.get("x-middleware-next") === "1") {
    return {
      continue: true,
      responseHeaders: collectMiddlewareHeaders(response),
      waitUntilPromises,
    };
  }

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("Location") ?? response.headers.get("location");
    if (location) {
      const responseHeaders = new Headers();
      for (const [key, value] of response.headers) {
        if (!key.startsWith("x-middleware-") && key.toLowerCase() !== "location") {
          responseHeaders.append(key, value);
        }
      }
      return {
        continue: false,
        redirectUrl: location,
        redirectStatus: response.status,
        response: stripMiddlewareHeadersFromResponse(response),
        responseHeaders,
        waitUntilPromises,
      };
    }
  }

  const rewriteUrl = response.headers.get("x-middleware-rewrite");
  if (rewriteUrl) {
    let rewritePath: string;
    try {
      const rewriteParsed = new URL(rewriteUrl, options.request.url);
      const requestOrigin = new URL(options.request.url).origin;
      rewritePath =
        rewriteParsed.origin === requestOrigin
          ? rewriteParsed.pathname + rewriteParsed.search
          : rewriteParsed.href;
    } catch {
      rewritePath = rewriteUrl;
    }
    return {
      continue: true,
      rewriteUrl: rewritePath,
      rewriteStatus: response.status !== 200 ? response.status : undefined,
      responseHeaders: collectMiddlewareHeaders(response),
      waitUntilPromises,
    };
  }

  return {
    continue: false,
    response: stripMiddlewareHeadersFromResponse(response),
    waitUntilPromises,
  };
}

export async function runGeneratedMiddleware(
  options: RunGeneratedMiddlewareOptions,
): Promise<MiddlewareResult> {
  const run = () => executeMiddleware(options);
  return options.ctx ? runWithExecutionContext(options.ctx, run) : run();
}
