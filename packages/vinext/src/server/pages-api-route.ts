import type { Route } from "../routing/pages-router.js";
import { NextRequest } from "../shims/server.js";
import { addQueryParam } from "../utils/query.js";
import {
  createPagesReqRes,
  parsePagesBodySizeLimit,
  parsePagesApiBody,
  type PagesRequestQuery,
  type PagesReqResRequest,
  type PagesReqResResponse,
  PagesApiBodyParseError,
} from "./pages-node-compat.js";

type PagesApiRouteModule = {
  config?: {
    api?: {
      bodyParser?: false | { sizeLimit?: number | string };
    };
    runtime?: string;
  };
  runtime?: string;
  default?: unknown;
};

export type PagesApiRouteMatch = {
  params: PagesRequestQuery;
  route: Pick<Route, "pattern"> & {
    module: PagesApiRouteModule;
  };
};

type HandlePagesApiRouteOptions = {
  match: PagesApiRouteMatch | null;
  onRevalidate?: (
    urlPath: string,
    options?: { unstable_onlyGenerated?: boolean },
  ) => Promise<void> | void;
  reportRequestError?: (error: Error, routePattern: string) => void | Promise<void>;
  request: Request;
  url: string;
};

const warnedEdgeRuntimeRoutes = new Set<string>();

function normalizeEdgeRuntimeResponse(response: Response): Response {
  if (!response.headers.has("content-encoding") && !response.headers.has("content-length")) {
    return response;
  }

  const headers = new Headers(response.headers);
  // Node's fetch decodes compressed upstream bodies but keeps the original
  // encoding headers. The deploy harness runs Pages edge routes in Node, so
  // strip body metadata before the production server optionally recompresses.
  headers.delete("content-encoding");
  headers.delete("content-length");

  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

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

function appendRouteParams(searchParams: URLSearchParams, params: PagesRequestQuery): void {
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        searchParams.append(key, item);
      }
    } else {
      searchParams.append(key, value);
    }
  }
}

function requestWithResolvedUrl(
  request: Request,
  url: string,
  params: PagesRequestQuery = {},
): Request {
  const resolvedUrl = new URL(url, request.url);
  appendRouteParams(resolvedUrl.searchParams, params);
  return new Request(resolvedUrl, request);
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
    const runtime = route.module.config?.runtime ?? route.module.runtime;
    if (runtime === "edge" || runtime === "experimental-edge") {
      if (!warnedEdgeRuntimeRoutes.has(route.pattern)) {
        warnedEdgeRuntimeRoutes.add(route.pattern);
        console.warn(
          `[vinext] Pages API route ${route.pattern} exports config.runtime = "edge". ` +
            "vinext does not implement Next.js Edge Runtime isolation; this route will run " +
            "as a best-effort Web Request/Response handler on the normal vinext runtime. " +
            "Prefer the default Node.js Pages API runtime, or migrate request-boundary logic " +
            "to proxy.ts. See https://nextjs.org/blog/next-16#proxyts-formerly-middlewarets",
        );
      }
      const resolvedRequest = requestWithResolvedUrl(options.request, options.url, params);
      const edgeRequest =
        resolvedRequest instanceof NextRequest ? resolvedRequest : new NextRequest(resolvedRequest);
      const edgeHandler = handler as (req: NextRequest) => unknown | Promise<unknown>;
      const result = await edgeHandler(edgeRequest);
      if (result instanceof Response) {
        return normalizeEdgeRuntimeResponse(result);
      }
      return new Response(null, { status: 204 });
    }

    const query = buildPagesApiQuery(options.url, params);
    const apiConfig = route.module.config?.api;
    const shouldParseBody = apiConfig?.bodyParser !== false;
    const sizeLimit =
      shouldParseBody && typeof apiConfig?.bodyParser === "object"
        ? parsePagesBodySizeLimit(apiConfig.bodyParser.sizeLimit)
        : undefined;
    const body = shouldParseBody ? await parsePagesApiBody(options.request, sizeLimit) : undefined;
    const { isResponsePiped, req, res, responsePromise } = createPagesReqRes({
      body,
      onRevalidate: options.onRevalidate,
      preserveRequestBodyStream: !shouldParseBody,
      query,
      request: options.request,
      url: options.url,
    });

    const nodeHandler = handler as (
      req: PagesReqResRequest,
      res: PagesReqResResponse,
    ) => unknown | Promise<unknown>;
    await nodeHandler(req, res);
    if (!res.headersSent && !isResponsePiped()) {
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
    return new Response("Internal Server Error", { status: 500 });
  }
}
