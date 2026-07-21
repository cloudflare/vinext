import "./server-globals.js";
import type { Route } from "../routing/pages-router.js";
import type { NextI18nConfig } from "../config/next-config.js";
import {
  mergeRouteParamsIntoQuery,
  parseQueryString,
  urlQueryToSearchParams,
} from "../utils/query.js";
import {
  createPagesReqRes,
  parsePagesApiBody,
  type PagesRequestQuery,
  type PagesReqResRequest,
  type PagesReqResResponse,
  PagesApiBodyParseError,
} from "./pages-node-compat.js";
import { resolveBodyParserConfig } from "./pages-body-parser-config.js";
import { internalServerErrorResponse } from "./http-error-responses.js";
import { cloneRequestWithUrl } from "./request-pipeline.js";
import { isEdgeApiRuntime } from "./edge-api-runtime.js";
import { runWithExecutionContext, type ExecutionContextLike } from "vinext/shims/request-context";
import { NextRequest } from "vinext/shims/server";

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

type PagesNodeApiRouteHandler = (req: PagesReqResRequest, res: PagesReqResResponse) => unknown;

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
  match: PagesApiRouteMatch | null;
  reportRequestError?: (error: Error, routePattern: string) => void | Promise<void>;
  request: Request;
  url: string;
  nextConfig?: {
    basePath?: string;
    allowedRevalidateHeaderKeys?: readonly string[];
    i18n?: NextI18nConfig | null;
    trailingSlash?: boolean;
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
  if (options.ctx) {
    return runWithExecutionContext(options.ctx, () => _handlePagesApiRoute(options));
  }
  return _handlePagesApiRoute(options);
}

async function _handlePagesApiRoute(options: HandlePagesApiRouteOptions): Promise<Response> {
  if (!options.match) {
    return new Response("404 - API route not found", { status: 404 });
  }

  const { route, params } = options.match;

  try {
    if (isEdgeApiRouteModule(route.module)) {
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
              },
            }
          : undefined,
      );
      const response = await route.module.default(nextRequest);
      if (response instanceof Response) {
        return response;
      }

      throw new Error("Edge API route did not return a Response");
    }

    // This is redundant at runtime after the edge branch for function exports, but it
    // keeps the Node handler ABI narrowed without a production type assertion.
    if (!isNodeApiRouteModule(route.module)) {
      return new Response("API route does not export a default function", { status: 500 });
    }

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

    const { req, res, responsePromise } = createPagesReqRes({
      allowedRevalidateHeaderKeys: options.nextConfig?.allowedRevalidateHeaderKeys,
      body,
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

    await route.module.default(req, res);
    // Auto-end if no stream is in progress. Without this guard a handler
    // that forgets to call res.end() would leave the request hanging.
    // Skipped for `externalResolver: true` routes, which legitimately
    // respond after the handler settles.
    if (!externalResolver && !resWasPiped && !res.headersSent) {
      res.end();
    }
    return await responsePromise;
  } catch (error) {
    if (error instanceof PagesApiBodyParseError) {
      return new Response(error.message, {
        status: error.statusCode,
        statusText: error.message,
      });
    }

    void options.reportRequestError?.(
      error instanceof Error ? error : new Error(String(error)),
      route.pattern,
    );
    return internalServerErrorResponse();
  }
}
