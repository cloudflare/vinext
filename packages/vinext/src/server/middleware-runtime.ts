import "./server-globals.js";
import type { NextI18nConfig } from "../config/next-config.js";
import { normalizePathnameForRouteMatchStrict } from "../routing/utils.js";
import {
  getRequestExecutionContext,
  runWithExecutionContext,
  type ExecutionContextLike,
} from "vinext/shims/request-context";
import { NextFetchEvent, NextRequest } from "vinext/shims/server";
import { normalizePath } from "./normalize-path.js";
import {
  MIDDLEWARE_HEADER_PREFIX,
  MIDDLEWARE_NEXT_HEADER,
  MIDDLEWARE_REWRITE_HEADER,
} from "./headers.js";
import { MatcherConfig, matchesMiddleware } from "./middleware-matcher.js";
import { shouldKeepMiddlewareHeader } from "./middleware-request-headers.js";
import { processMiddlewareHeaders } from "./request-pipeline.js";
import { badRequestResponse, internalServerErrorResponse } from "./http-error-responses.js";

export type MiddlewareModule = Record<string, unknown>;

export type MiddlewareResult = {
  continue: boolean;
  redirectUrl?: string;
  redirectStatus?: number;
  rewriteUrl?: string;
  rewriteStatus?: number;
  status?: number;
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
  /**
   * Whether the incoming request was a Next.js `_next/data` fetch (carried
   * `x-nextjs-data: 1`). The header itself is stripped by `filterInternalHeaders`
   * before the middleware request is constructed, so callers must capture this
   * flag from the raw incoming headers and forward it explicitly.
   */
  isDataRequest?: boolean;
  isProxy: boolean;
  module: MiddlewareModule;
  normalizedPathname?: string;
  request: Request;
  /**
   * The user's `trailingSlash` config. Plumbed into the NextRequest's NextURL
   * so `request.nextUrl.toString()` formats with the configured slash policy,
   * which feeds into `NextResponse.redirect(request.nextUrl)` Location headers.
   * Also used to normalize redirect Location pathnames returned via plain
   * `new URL('/x', req.url)`.
   */
  trailingSlash?: boolean;
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

/**
 * Make a same-host URL relative to the request origin. Cross-origin URLs are
 * returned unchanged. Mirrors Next.js's `getRelativeURL` behaviour:
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/router/utils/relativize-url.ts
 */
function relativizeLocation(location: string, requestUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(location, requestUrl);
  } catch {
    return location;
  }
  const base = new URL(requestUrl);
  if (parsed.origin !== base.origin) return parsed.toString();
  return parsed.pathname + parsed.search + parsed.hash;
}

/**
 * Translate a middleware redirect Response into the soft-redirect protocol
 * used by Next.js for `_next/data` requests: a 200 OK with the redirect target
 * carried in the `x-nextjs-redirect` header. The client router consumes this
 * header to perform the navigation, avoiding CORS issues that would arise from
 * an actual cross-origin HTTP redirect on a data fetch.
 *
 * Reference: packages/next/src/server/web/adapter.ts
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/server/web/adapter.ts
 */
function dataRedirectResponse(target: string, originalResponse: Response): Response {
  const headers = new Headers(originalResponse.headers);
  processMiddlewareHeaders(headers);
  // Headers.delete is case-insensitive per the Fetch spec, so a single call
  // covers `Location` / `location` / `LOCATION`.
  headers.delete("Location");
  headers.set("x-nextjs-redirect", target);
  return new Response(null, { status: 200, headers });
}

function collectMiddlewareHeaders(response: Response): Headers {
  const responseHeaders = new Headers();
  for (const [key, value] of response.headers) {
    if (!key.startsWith(MIDDLEWARE_HEADER_PREFIX) || shouldKeepMiddlewareHeader(key)) {
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
    return badRequestResponse();
  }
}

function createNextRequest(
  request: Request,
  normalizedPathname: string,
  i18nConfig?: NextI18nConfig | null,
  basePath?: string,
  trailingSlash?: boolean,
): NextRequest {
  const url = new URL(request.url);
  // Middleware gets an isolated body branch; downstream routing keeps owning
  // the original request body.
  let mwRequest = request.body && !request.bodyUsed ? request.clone() : request;
  if (normalizedPathname !== url.pathname) {
    const mwUrl = new URL(url);
    mwUrl.pathname = normalizedPathname;
    mwRequest = new Request(mwUrl, mwRequest);
  }

  const hasNextConfig = basePath || i18nConfig || trailingSlash;
  const nextConfig = hasNextConfig
    ? {
        basePath: basePath ?? "",
        i18n: i18nConfig ?? undefined,
        trailingSlash: trailingSlash ?? undefined,
      }
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
    options.trailingSlash,
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
      response: internalServerErrorResponse(message),
      waitUntilPromises,
    };
  }

  const waitUntilPromises = drainFetchEvent(fetchEvent);

  if (!response) {
    return { continue: true, waitUntilPromises };
  }

  if (response.headers.get(MIDDLEWARE_NEXT_HEADER) === "1") {
    return {
      continue: true,
      responseHeaders: collectMiddlewareHeaders(response),
      status: response.status !== 200 ? response.status : undefined,
      waitUntilPromises,
    };
  }

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("Location") ?? response.headers.get("location");
    if (location) {
      // Make same-host Location relative for parity with Next.js, which only
      // emits absolute URLs for cross-origin redirects:
      // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/web/adapter.ts
      const relativeLocation = relativizeLocation(location, options.request.url);

      // Normalize trailing slash on middleware redirect Locations that came
      // from a plain `new URL(...)` rather than `request.nextUrl`. NextURL
      // already applies the policy at stringify time, but plain URLs bypass it.
      let normalizedLocation = relativeLocation;
      if (options.trailingSlash !== undefined) {
        try {
          const loc = new URL(relativeLocation, options.request.url);
          if (loc.origin === new URL(options.request.url).origin) {
            // Use the same plain add/strip rule as NextURL._applyTrailingSlash /
            // Next.js's formatNextPathnameInfo — no exemptions for /api, file
            // extensions, etc. Only root is exempt.
            const p = loc.pathname;
            let normalized: string | null = null;
            if (p !== "" && p !== "/") {
              if (options.trailingSlash) {
                normalized = p.endsWith("/") ? null : p + "/";
              } else {
                normalized = p.endsWith("/") ? p.slice(0, -1) : null;
              }
            }
            if (normalized !== null) {
              normalizedLocation = normalized + loc.search + loc.hash;
            }
          }
        } catch {
          // malformed URL — leave as-is
        }
      }

      // For `_next/data` requests, translate the HTTP redirect into the
      // `x-nextjs-redirect` soft-redirect protocol so the client router can
      // perform the navigation without tripping CORS on cross-origin targets.
      // `x-nextjs-data` lives in INTERNAL_HEADERS and is stripped before the
      // middleware request is constructed, so the flag is threaded in from the
      // caller (which sees the raw incoming headers).
      if (options.isDataRequest) {
        return {
          continue: false,
          response: dataRedirectResponse(normalizedLocation, response),
          waitUntilPromises,
        };
      }

      const responseHeaders = new Headers();
      for (const [key, value] of response.headers) {
        if (!key.startsWith(MIDDLEWARE_HEADER_PREFIX) && key.toLowerCase() !== "location") {
          responseHeaders.append(key, value);
        }
      }
      // Rebuild the response with the relativized Location so consumers that
      // forward `result.response` (rather than `result.redirectUrl`) also send
      // the correct header.
      const relativizedResponseHeaders = new Headers(response.headers);
      relativizedResponseHeaders.set("Location", normalizedLocation);
      const relativizedResponse = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: relativizedResponseHeaders,
      });
      return {
        continue: false,
        redirectUrl: normalizedLocation,
        redirectStatus: response.status,
        response: stripMiddlewareHeadersFromResponse(relativizedResponse),
        responseHeaders,
        waitUntilPromises,
      };
    }
  }

  const rewriteUrl = response.headers.get(MIDDLEWARE_REWRITE_HEADER);
  if (rewriteUrl) {
    let rewritePath: string;
    try {
      const rewriteParsed = new URL(rewriteUrl, options.request.url);
      const requestOrigin = new URL(options.request.url).origin;
      if (rewriteParsed.origin === requestOrigin) {
        // Middleware constructs the rewrite-target URL itself (e.g. by
        // modifying `request.nextUrl` or by passing a fresh path). Whatever
        // search params that URL carries IS the final query — vinext must not
        // silently re-merge the original request's query, or middleware that
        // deletes keys (e.g. `searchParams.delete('foo')`) would see them
        // resurrected on the rewrite target. Mirrors Next.js' middleware
        // adapter: the `x-middleware-rewrite` URL is parsed directly with no
        // original-side merging.
        // See test/e2e/middleware-rewrites/test/index.test.ts
        //   ("should clear query parameters")
        // https://github.com/vercel/next.js/blob/canary/test/e2e/middleware-rewrites/test/index.test.ts
        rewritePath = rewriteParsed.pathname + rewriteParsed.search;
      } else {
        // External rewrites are proxied as-is; don't smuggle local query params
        // into the upstream URL.
        rewritePath = rewriteParsed.href;
      }
    } catch {
      rewritePath = rewriteUrl;
    }
    return {
      continue: true,
      rewriteUrl: rewritePath,
      rewriteStatus: response.status !== 200 ? response.status : undefined,
      responseHeaders: collectMiddlewareHeaders(response),
      status: response.status !== 200 ? response.status : undefined,
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
