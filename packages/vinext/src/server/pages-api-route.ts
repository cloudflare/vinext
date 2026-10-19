import "./server-globals.js";
import type { Route } from "../routing/pages-router.js";
import type { NextI18nConfig } from "../config/next-config.js";
import {
  mergeRouteParamsIntoQuery,
  parseQueryString,
  urlQueryToSearchParams,
} from "../utils/query.js";
import {
  createPagesApiReqRes,
  hasUserSetPagesResponseHeader,
  markVinextStreamedApiResponse,
  parsePagesApiBody,
  sendPagesApiError,
  type PagesRequestQuery,
  type PagesReqResRequest,
  type PagesApiReqResResponse,
  PagesApiBodyParseError,
} from "./pages-node-compat.js";
import { resolveBodyParserConfig } from "./pages-body-parser-config.js";
import { internalServerErrorResponse } from "./http-error-responses.js";
import { cloneRequestWithUrl } from "./request-pipeline.js";
import {
  finalizeEdgeApiResponse,
  isEdgeApiRuntime,
  type EdgeApiExecutionRuntime,
} from "./edge-api-runtime.js";
import {
  getRequestExecutionContext,
  runWithExecutionContext,
  type ExecutionContextLike,
} from "vinext/shims/request-context";
import { NextRequest } from "vinext/shims/server";
import { markRouteCacheabilityExplicitResponsePolicy } from "vinext/shims/cacheability-classification";
import { hasCdnResponsePolicy, isCdnResponsePolicyHeader } from "./cache-control.js";
import { applyRouteHandlerMiddlewareContext } from "./app-route-handler-middleware-context.js";
import { tracePagesApiHandler } from "./pages-execution-tracing.js";

type PagesApiRouteConfig = {
  runtime?: string;
  /**
   * `export const config = { api: { bodyParser: false | { sizeLimit: '4mb' } } }`
   * — controls whether vinext parses the request body for the route handler.
   *
   * `bodyParser: false` is critical for webhook handlers (Stripe, GitHub,
   * Slack, etc.) that need to read the raw bytes to verify an HMAC
   * signature. With it set, `req.body` is left undefined and the raw stream
   * remains available through the Node-readable request object.
   *
   * @see https://nextjs.org/docs/pages/building-your-application/routing/api-routes#custom-config
   */
  api?: {
    bodyParser?: boolean | { sizeLimit?: string | number };
    responseLimit?: boolean | string | number;
    /**
     * `externalResolver: true` declares that the response is sent by an
     * external resolver (e.g. express/connect proxy middleware) that may
     * complete after the handler's promise settles. Next.js uses it to
     * suppress the "API resolved without sending a response" dev warning;
     * vinext additionally uses it to suppress the auto-`end()` safety net,
     * which would otherwise resolve an empty response before the external
     * resolver writes.
     *
     * @see https://nextjs.org/docs/pages/building-your-application/routing/api-routes#custom-config
     */
    externalResolver?: boolean;
  };
};

type PagesNodeApiRouteHandler = (req: PagesReqResRequest, res: PagesApiReqResResponse) => unknown;

type PagesEdgeApiRouteHandler = (request: Request) => Response | Promise<Response>;

type PagesApiRouteModule = {
  /**
   * `export const config = { runtime: 'edge' }` — historical Pages Router form.
   */
  config?: PagesApiRouteConfig;
  /**
   * `export const runtime = 'edge'` — bare export form. Next.js resolves the
   * effective runtime as `config.runtime ?? config.config?.runtime`, so a
   * top-level `runtime` export takes precedence over the nested config form.
   *
   * @see https://github.com/vercel/next.js/blob/canary/packages/next/src/build/analysis/get-page-static-info.ts
   */
  runtime?: string;
  default?: PagesNodeApiRouteHandler | PagesEdgeApiRouteHandler;
};

function resolveModuleRuntime(module: PagesApiRouteModule): string | undefined {
  return module.runtime ?? module.config?.runtime;
}

export type PagesApiRouteMatch = {
  params: PagesRequestQuery;
  route: Pick<Route, "pattern"> & {
    module: PagesApiRouteModule;
  };
};

type HandlePagesApiRouteOptions = {
  /**
   * Per-request Cloudflare Workers `ExecutionContext`. When provided, the
   * API route runs inside `runWithExecutionContext(ctx, ...)` so any
   * `after()` (or other shim) call inside the handler can reach
   * `ctx.waitUntil()` via the ALS and keep the isolate alive past the
   * response. Omit on Node.js dev where no Workers lifecycle exists.
   */
  ctx?: ExecutionContextLike;
  edgeRuntime?: EdgeApiExecutionRuntime;
  /** Headers installed before user code, matching Next.js custom-route ordering. */
  initialResponseHeaders?: Headers;
  /**
   * Middleware response headers. As in Next.js, Node handlers receive them on
   * `res` before they run, so the handler's own `setHeader()` wins, and an
   * edge handler's headers are appended after them.
   */
  middlewareResponseHeaders?: Headers | null;
  /** Middleware's Set-Cookie values among `initialResponseHeaders`. */
  middlewareSetCookies?: readonly string[];
  match: PagesApiRouteMatch | null;
  reportRequestError?: (error: Error, routePattern: string) => void | Promise<void>;
  request: Request;
  url: string;
  nextConfig?: {
    basePath?: string;
    allowedRevalidateHeaderKeys?: readonly string[];
    i18n?: NextI18nConfig | null;
    trailingSlash?: boolean;
    skipTrailingSlashRedirect?: boolean;
  };
  trustedRevalidateOrigin?: string;
};

function buildPagesApiQuery(url: string, params: PagesRequestQuery): PagesRequestQuery {
  return mergeRouteParamsIntoQuery(parseQueryString(url), params);
}

function createEdgeApiRequest(request: Request, url: string, params: PagesRequestQuery): Request {
  const resolvedUrl = new URL(request.url);
  resolvedUrl.search = urlQueryToSearchParams(buildPagesApiQuery(url, params)).toString();
  const resolvedUrlString = resolvedUrl.toString();
  return resolvedUrlString === request.url
    ? request
    : cloneRequestWithUrl(request, resolvedUrlString);
}

function isEdgeApiRouteModule(
  module: PagesApiRouteModule,
): module is PagesApiRouteModule & { default: PagesEdgeApiRouteHandler } {
  return typeof module.default === "function" && isEdgeApiRuntime(resolveModuleRuntime(module));
}

function isNodeApiRouteModule(
  module: PagesApiRouteModule,
): module is PagesApiRouteModule & { default: PagesNodeApiRouteHandler } {
  return typeof module.default === "function" && !isEdgeApiRuntime(resolveModuleRuntime(module));
}

export async function handlePagesApiRoute(options: HandlePagesApiRouteOptions): Promise<Response> {
  const run = async () => {
    const response = await _handlePagesApiRoute(options);
    if (hasHandlerCdnResponsePolicy(response.headers, options.middlewareResponseHeaders)) {
      markRouteCacheabilityExplicitResponsePolicy();
    }
    return response;
  };
  return options.ctx ? runWithExecutionContext(options.ctx, run) : run();
}

/**
 * Whether the response carries a CDN policy other than middleware's. Node
 * handler writes of middleware's own value are recorded on `res` instead.
 */
function hasHandlerCdnResponsePolicy(
  headers: Headers,
  middlewareHeaders: Headers | null | undefined,
): boolean {
  if (!middlewareHeaders) return hasCdnResponsePolicy(headers);
  for (const [name, value] of headers) {
    if (isCdnResponsePolicyHeader(name) && middlewareHeaders.get(name) !== value) return true;
  }
  return false;
}

/**
 * Next.js runEdgeFunction() appends every edge response header onto the Node
 * response that already holds next.config and middleware headers, so a header
 * both set keeps each value, the edge handler's last. Its appendHeader() skips
 * a value the header already carries.
 */
function appendEdgeApiResponseHeaders(
  response: Response,
  initialHeaders: Headers | undefined,
  middlewareHeaders: Headers | null | undefined,
): Response {
  // Record the handler's own policy before a value middleware shares hides it.
  if (hasCdnResponsePolicy(response.headers)) markRouteCacheabilityExplicitResponsePolicy();
  if (!initialHeaders?.keys().next().value && !middlewareHeaders?.keys().next().value) {
    return response;
  }
  // Installed like a Node handler's `res`: middleware's values replace
  // next.config's, and its cookies follow them.
  const values = new Map<string, string[]>();
  for (const source of [initialHeaders, middlewareHeaders]) {
    for (const [name, value] of source ?? []) {
      if (name !== "set-cookie") values.set(name, [value]);
    }
  }
  values.set("set-cookie", [
    ...(initialHeaders?.getSetCookie() ?? []),
    ...(middlewareHeaders?.getSetCookie() ?? []),
  ]);
  const append = (name: string, value: string) => {
    const current = values.get(name) ?? [];
    if (!current.includes(value)) values.set(name, [...current, value]);
  };
  for (const [name, value] of response.headers) {
    if (name !== "set-cookie") append(name, value);
  }
  for (const cookie of response.headers.getSetCookie()) append("set-cookie", cookie);
  const headers = new Headers();
  for (const [name, list] of values) {
    for (const value of list) headers.append(name, value);
  }
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

async function _handlePagesApiRoute(options: HandlePagesApiRouteOptions): Promise<Response> {
  // Next.js writes middleware headers onto `res` before apiResolver runs, and
  // its error responses reuse that `res`, so they keep middleware's headers.
  const frameworkResponse = (response: Response) =>
    applyRouteHandlerMiddlewareContext(
      response,
      { headers: options.middlewareResponseHeaders ?? null, status: null },
      { appendResponseChallenges: false },
    );

  if (!options.match) {
    return frameworkResponse(new Response("404 - API route not found", { status: 404 }));
  }

  const { route, params } = options.match;
  // Like apiResolver's single catch, report one error per request: a stream
  // failure can reject both the response bridge and the handler.
  let errorReport: Promise<void> | undefined;
  const reportError = (error: unknown) =>
    (errorReport ??= Promise.resolve(
      options.reportRequestError?.(
        error instanceof Error ? error : new Error(String(error)),
        route.pattern,
      ),
    ));
  // Settles after the Node handler and any report of its own rejection.
  let handlerSettled: Promise<unknown> | undefined;
  let handlerRunning = false;

  try {
    if (isEdgeApiRouteModule(route.module)) {
      const handler = route.module.default;
      // Next.js wraps the incoming Request in a NextRequest before invoking
      // edge API handlers, so handlers can use `req.nextUrl.searchParams`,
      // `req.cookies`, etc. (Cf. NextRequestHint in next/src/server/web/adapter.ts.)
      const nextRequest = new NextRequest(
        createEdgeApiRequest(options.request, options.url, params),
        options.nextConfig
          ? {
              nextConfig: {
                basePath: options.nextConfig.basePath,
                i18n: options.nextConfig.i18n ?? undefined,
                trailingSlash: options.nextConfig.trailingSlash,
                skipTrailingSlashRedirect: options.nextConfig.skipTrailingSlashRedirect,
              },
            }
          : undefined,
      );
      const response = await tracePagesApiHandler(route.pattern, () => handler(nextRequest));
      if (response instanceof Response) {
        return appendEdgeApiResponseHeaders(
          finalizeEdgeApiResponse(response, options.edgeRuntime ?? "worker"),
          options.initialResponseHeaders,
          options.middlewareResponseHeaders,
        );
      }

      throw new Error("Edge API route did not return a Response");
    }

    // This is redundant at runtime after the edge branch for function exports, but it
    // keeps the Node handler ABI narrowed without a production type assertion.
    if (!isNodeApiRouteModule(route.module)) {
      return frameworkResponse(
        new Response("API route does not export a default function", { status: 500 }),
      );
    }
    const handler = route.module.default;

    const query = buildPagesApiQuery(options.url, params);

    // Honour `export const config = { api: { bodyParser: ... } }` on the
    // route module. When the handler opts out (`bodyParser: false`) we must
    // not consume the stream — `req.body` stays `undefined` and the raw
    // bytes are exposed via the Node-readable `req` itself, matching Next.js's
    // `IncomingMessage` contract. User code can drain them with
    // `for await (const chunk of req)` or stream them with `req.pipe(...)`.
    // See issue #1479.
    const bodyParserConfig = resolveBodyParserConfig(route.module.config);

    const body = bodyParserConfig.enabled
      ? await parsePagesApiBody(options.request, bodyParserConfig.sizeLimit)
      : undefined;

    const { req, res, responsePromise } = createPagesApiReqRes({
      allowedRevalidateHeaderKeys: options.nextConfig?.allowedRevalidateHeaderKeys,
      body,
      initialResponseHeaders: options.initialResponseHeaders,
      middlewareResponseHeaders: options.middlewareResponseHeaders,
      middlewareSetCookies: options.middlewareSetCookies,
      query,
      request: options.request,
      trustedRevalidateOrigin: options.trustedRevalidateOrigin,
      url: options.url,
    });

    // Track whether `res` has had a pipe destination attached. Next.js skips
    // auto-ending when a stream is being piped (matching the Node.js "pipe"
    // event on ServerResponse). The "pipe" event is the canonical stream
    // signal; the handler return value is not — chainable helpers like
    // `return res.status(202)` return `this` without implying streaming.
    let resWasPiped = false;
    res.once("pipe", () => {
      resWasPiped = true;
    });

    // Mirrors apiResolver: `config.api?.externalResolver || false`. Next.js
    // never auto-ends — when this flag is set it only suppresses the dev
    // warning and the response is delivered whenever the external resolver
    // (e.g. proxy middleware that attaches its pipe asynchronously) sends it.
    const externalResolver = route.module.config?.api?.externalResolver || false;

    const completeHandler = () => {
      // Auto-end if no stream is in progress. Without this guard a handler
      // that forgets to call res.end() would leave the request hanging.
      // Skipped for `externalResolver: true` routes, which legitimately
      // respond after the handler settles.
      if (!externalResolver && !resWasPiped && !res.headersSent) {
        res.end();
      }
    };
    const finalizeResponse = (response: Response) => {
      // A middleware value installed on `res` is not the handler's policy, but
      // the handler re-setting that same value is.
      if (hasUserSetPagesResponseHeader(res, isCdnResponsePolicyHeader)) {
        markRouteCacheabilityExplicitResponsePolicy();
      }
      // The response resolves on the first write; if `end()` still has not
      // been called by the time it settles, the body is a live stream (e.g. a
      // piped proxy upstream). Mark it so buffering adapters forward it as a
      // stream instead of holding the whole body in memory until the source
      // closes.
      if (!res.writableEnded) {
        markVinextStreamedApiResponse(response);
      }
      return response;
    };
    const sendHandlerError = async (error: unknown) => {
      await reportError(error);
      // Next.js apiResolver answers a thrown handler with sendError() on the
      // same `res`, so the 500 keeps the headers the handler already set and
      // gets no Content-Type. A response that already started is finished
      // with the message rather than aborted.
      sendPagesApiError(res, 500, "Internal Server Error");
      return { type: "handler" as const };
    };

    const responseReady = responsePromise.then((response) => ({
      type: "response" as const,
      response,
    }));
    // Schedule invocation after both sides of the race have rejection
    // handlers attached.
    handlerRunning = true;
    const handlerCompletion = Promise.resolve()
      .then(() =>
        tracePagesApiHandler(route.pattern, () => handler(req, res), {
          recordErrors: options.edgeRuntime !== "node",
        }),
      )
      .finally(() => {
        handlerRunning = false;
      })
      .then(() => ({ type: "handler" as const }), sendHandlerError);
    handlerSettled = handlerCompletion;

    // A real Node ServerResponse is consumed by the socket while the API
    // handler is still running. Mirror that concurrency at the Fetch boundary:
    // a handler is allowed to await pipeline() or `drain`, so expose the body
    // as soon as its first write commits the Response instead of waiting for
    // the handler to finish first.
    const firstSettled = await Promise.race([responseReady, handlerCompletion]);
    if (firstSettled.type === "response") {
      const handlerLifecycle = handlerCompletion.then(completeHandler);
      // The body may already be complete (for example, res.end() followed by
      // awaited cleanup), so keeping only a floating promise is not enough on
      // Workers. Register the remaining handler lifecycle before returning;
      // this also covers hybrid App/Pages requests, where the context is
      // inherited from the surrounding App Router handler rather than passed
      // through options.ctx.
      getRequestExecutionContext()?.waitUntil(handlerLifecycle);
      return finalizeResponse(firstSettled.response);
    }

    completeHandler();
    return finalizeResponse(await responsePromise);
  } catch (error) {
    if (error instanceof PagesApiBodyParseError) {
      return frameworkResponse(
        new Response(error.message, {
          status: error.statusCode,
          statusText: error.message,
        }),
      );
    }

    // A stream failure can reject the response before the handler rejects
    // (an awaited pipeline() destroys `res` first). apiResolver reports the
    // handler's error, so this one is reported only if the handler completes.
    // A handler still running must not hold the 500 back.
    const report = handlerSettled
      ? handlerSettled.then(() => reportError(error))
      : reportError(error);
    if (handlerRunning) getRequestExecutionContext()?.waitUntil(report);
    else await report;
    return frameworkResponse(internalServerErrorResponse());
  }
}
