import "./server-globals.js";
import type { Route } from "../routing/pages-router.js";
import { mergeRouteParamsIntoQuery, parseQueryString } from "../utils/query.js";
import {
  createPagesReqRes,
  parsePagesApiBody,
  type PagesRequestQuery,
  type PagesReqResRequest,
  type PagesReqResResponse,
  PagesApiBodyParseError,
} from "./pages-node-compat.js";
import { internalServerErrorResponse } from "./http-error-responses.js";
import { isEdgeApiRuntime } from "./edge-api-runtime.js";
import { NextRequest } from "vinext/shims/server";

type PagesApiRouteConfig = {
  runtime?: string;
};

type PagesNodeApiRouteHandler = (
  req: PagesReqResRequest,
  res: PagesReqResResponse,
) => void | Promise<void>;

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
  match: PagesApiRouteMatch | null;
  reportRequestError?: (error: Error, routePattern: string) => void | Promise<void>;
  request: Request;
  url: string;
};

function buildPagesApiQuery(url: string, params: PagesRequestQuery): PagesRequestQuery {
  return mergeRouteParamsIntoQuery(parseQueryString(url), params);
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
  if (!options.match) {
    return new Response("404 - API route not found", { status: 404 });
  }

  const { route, params } = options.match;

  try {
    if (isEdgeApiRouteModule(route.module)) {
      // Next.js wraps the incoming Request in a NextRequest before invoking
      // edge API handlers, so handlers can use `req.nextUrl.searchParams`,
      // `req.cookies`, etc. (Cf. NextRequestHint in next/src/server/web/adapter.ts.)
      const nextRequest = new NextRequest(options.request);
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
    const body = await parsePagesApiBody(options.request);
    const { req, res, responsePromise } = createPagesReqRes({
      body,
      query,
      request: options.request,
      url: options.url,
    });

    await route.module.default(req, res);
    res.end();
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
