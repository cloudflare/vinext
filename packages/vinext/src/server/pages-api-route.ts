import type { Route } from "../routing/pages-router.js";
import { addQueryParam } from "../utils/query.js";
import {
  createPagesReqRes,
  parsePagesApiBody,
  type PagesRequestQuery,
  type PagesReqResRequest,
  type PagesReqResResponse,
  PagesApiBodyParseError,
} from "./pages-node-compat.js";

type PagesApiRouteModule = {
  default?: (req: PagesReqResRequest, res: PagesReqResResponse) => void | Promise<void>;
};

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
  const query: PagesRequestQuery = { ...params };
  const search = url.split("?")[1];
  if (!search) {
    return query;
  }

  for (const [key, value] of new URLSearchParams(search)) {
    addQueryParam(query, key, value);
  }

  return query;
}

export async function handlePagesApiRoute(options: HandlePagesApiRouteOptions): Promise<Response> {
  if (!options.match) {
    return new Response("404 - API route not found", { status: 404 });
  }

  const { route, params } = options.match;
  const handler = route.module.default;
  if (typeof handler !== "function") {
    return new Response("API route does not export a default function", { status: 500 });
  }

  try {
    const query = buildPagesApiQuery(options.url, params);
    const body = await parsePagesApiBody(options.request);
    const { req, res, responsePromise } = createPagesReqRes({
      body,
      query,
      request: options.request,
      url: options.url,
    });

    await handler(req, res);
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
    return new Response("Internal Server Error", { status: 500 });
  }
}
