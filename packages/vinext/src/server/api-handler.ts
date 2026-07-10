/**
 * API route handler for Pages Router (pages/api/*).
 *
 * Next.js API routes export a default handler function:
 *   export default function handler(req, res) { ... }
 *
 * The req/res objects are Node.js IncomingMessage/ServerResponse with
 * Next.js extensions: req.query, req.body, res.json(), res.status(), etc.
 */
import "./server-globals.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { NextI18nConfig } from "../config/next-config.js";
import { decode as decodeQueryString } from "node:querystring";
import { Buffer } from "node:buffer";
import { type Route, matchRoute } from "../routing/pages-router.js";
import { reportRequestError, importModule, type ModuleImporter } from "./instrumentation.js";
import {
  mergeRouteParamsIntoQuery,
  parseQueryString,
  urlQueryToSearchParams,
} from "../utils/query.js";
import { PagesBodyParseError, getMediaType, isJsonMediaType } from "./pages-media-type.js";
import { isEdgeApiRuntime } from "./edge-api-runtime.js";
import {
  DEFAULT_PAGES_API_BODY_SIZE_LIMIT,
  resolveBodyParserConfig,
} from "./pages-body-parser-config.js";
import { resolveRequestProtocol, resolveRequestHost } from "./proxy-trust.js";
import { performOnDemandRevalidate, type RevalidateOptions } from "./pages-revalidate.js";
import { NextRequest } from "vinext/shims/server";
import { hasBasePath } from "../utils/base-path.js";
import {
  attachPagesPreviewApi,
  attachPagesRequestCookies,
  type PagesReqResRequest,
  type PagesReqResResponse,
} from "./pages-node-compat.js";

/**
 * Extend the Node.js request with Next.js-style helpers.
 */
type NextApiRequest = {
  query: Record<string, string | string[]>;
  body: unknown;
  cookies: Record<string, string>;
  preview?: true;
  draftMode?: true;
  previewData: object | string | false;
} & IncomingMessage;

/**
 * Extend the Node.js response with Next.js-style helpers.
 */
type NextApiResponse = {
  status(code: number): NextApiResponse;
  json(data: unknown): void;
  send(data: unknown): void;
  redirect(statusOrUrl: number | string, url?: string): NextApiResponse;
  revalidate(urlPath: string, opts?: RevalidateOptions): Promise<void>;
  setPreviewData(
    data: object | string,
    options?: { maxAge?: number; path?: string },
  ): NextApiResponse;
  clearPreviewData(options?: { path?: string }): NextApiResponse;
  setDraftMode(options?: { enable?: boolean }): NextApiResponse;
} & ServerResponse;

type EdgeApiRouteModule = {
  /**
   * `export const config = { runtime: 'edge' }` — historical Pages Router form.
   */
  config?: {
    runtime?: string;
  };
  /**
   * `export const runtime = 'edge'` — bare export form. Next.js resolves the
   * effective runtime as `config.runtime ?? config.config?.runtime`, so a
   * top-level `runtime` export takes precedence over the nested config form.
   */
  runtime?: string;
  default: (request: Request) => Response | Promise<Response>;
};

/**
 * Default request body size (1 MB). Matches Next.js default bodyParser sizeLimit.
 * @see https://nextjs.org/docs/pages/building-your-application/routing/api-routes#custom-config
 * Prevents denial-of-service via unbounded request body buffering.
 */
const MAX_BODY_SIZE = DEFAULT_PAGES_API_BODY_SIZE_LIMIT;

/**
 * Parse the request body based on content-type.
 * Enforces a size limit to prevent memory exhaustion attacks.
 *
 * The `sizeLimit` argument honours `export const config = { api: { bodyParser:
 * { sizeLimit: '4mb' } } }` on the route module. To opt out of parsing
 * entirely (`bodyParser: false`), callers must skip this function so the
 * underlying readable stream stays intact on `req` (critical for webhook
 * HMAC signature verification).
 */
async function parseBody(
  req: IncomingMessage,
  sizeLimit: number = MAX_BODY_SIZE,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    let settled = false;
    req.on("data", (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > sizeLimit) {
        settled = true;
        req.destroy();
        reject(new PagesBodyParseError("Request body too large", 413));
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString("utf-8");
      const mediaType = getMediaType(req.headers["content-type"]);
      if (!raw) {
        resolve(
          isJsonMediaType(mediaType)
            ? {}
            : mediaType === "application/x-www-form-urlencoded"
              ? decodeQueryString(raw)
              : undefined,
        );
        return;
      }
      if (isJsonMediaType(mediaType)) {
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new PagesBodyParseError("Invalid JSON", 400));
        }
      } else if (mediaType === "application/x-www-form-urlencoded") {
        resolve(decodeQueryString(raw));
      } else {
        resolve(raw);
      }
    });
  });
}

function isEdgeApiRouteModule(module: Record<string, unknown>): module is EdgeApiRouteModule {
  if (typeof module.default !== "function") return false;
  // Bare `export const runtime = 'edge'` takes precedence over the nested config
  // form, matching Next.js (`config.runtime ?? config.config?.runtime` in
  // packages/next/src/build/analysis/get-page-static-info.ts).
  const bare = module.runtime;
  if (typeof bare === "string") return isEdgeApiRuntime(bare);
  const config = module.config;
  if (!config || typeof config !== "object") return false;
  const runtime = "runtime" in config ? (config as { runtime?: unknown }).runtime : undefined;
  return typeof runtime === "string" && isEdgeApiRuntime(runtime);
}

function readEdgeRequestBody(req: IncomingMessage): ReadableStream<Uint8Array> | undefined {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      req.on("data", (chunk: Buffer | string) => {
        controller.enqueue(typeof chunk === "string" ? Buffer.from(chunk) : new Uint8Array(chunk));
      });
      req.on("end", () => controller.close());
      req.on("error", (error) => controller.error(error));
    },
  });
}

function createEdgeApiRequest(
  req: IncomingMessage,
  url: string,
  params: Record<string, string | string[]>,
  nextConfig?: { basePath?: string },
): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    // Skip HTTP/2 pseudo-headers (`:method`/`:authority`/`:path`/`:scheme`,
    // RFC 7540 §8.1.2.1) — WHATWG `Headers` rejects `:`-prefixed names.
    // See: https://github.com/cloudflare/vinext/issues/2013
    if (name.startsWith(":")) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }

  // Honor `X-Forwarded-Proto` / `X-Forwarded-Host` only when running behind
  // a trusted proxy (gated on `VINEXT_TRUST_PROXY` / `VINEXT_TRUSTED_HOSTS`).
  // Without this gate a client could send `X-Forwarded-Proto: https` and
  // trick edge API handlers that check `request.url.startsWith("https")`
  // (e.g. to gate Secure-cookie issuance) into believing the request was
  // TLS-terminated. See: Finding F-PROD-7 in SECURITY-AUDIT-2026-05.md.
  const proto = resolveRequestProtocol(req);
  const host = resolveRequestHost(req, "localhost");
  // Keep this in sync with pages-api-route.ts: preserve the visible incoming
  // pathname while replacing only the resolved query and dynamic params.
  // Dev runs after Vite has stripped its configured basePath, so reconstruct
  // it here; prod/Workers do this earlier in pages-request-pipeline.ts using
  // the adapter's hadBasePath state before calling pages-api-route.ts.
  const requestUrl = new URL(req.url ?? url, `${proto}://${host}`);
  const basePath = nextConfig?.basePath;
  if (basePath && !hasBasePath(requestUrl.pathname, basePath)) {
    requestUrl.pathname = `${basePath}${requestUrl.pathname}`;
  }
  const query = mergeRouteParamsIntoQuery(parseQueryString(url), params);
  requestUrl.search = urlQueryToSearchParams(query).toString();
  const body = readEdgeRequestBody(req);

  const init: RequestInit & { duplex?: "half" } = {
    headers,
    method: req.method,
  };

  if (body) {
    init.body = body;
    init.duplex = "half";
  }

  return new Request(requestUrl, init);
}

function waitForWritableDrain(res: ServerResponse): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off("drain", onDrain);
      res.off("error", onError);
      res.off("close", onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Response closed before writable drain"));
    };
    res.once("drain", onDrain);
    res.once("error", onError);
    res.once("close", onClose);
  });
}

async function writeEdgeApiResponseBody(
  res: ServerResponse,
  body: ReadableStream<Uint8Array> | null,
): Promise<void> {
  if (!body) {
    res.end();
    return;
  }

  const reader = body.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (result.value.byteLength === 0) continue;
      if (!res.write(Buffer.from(result.value))) {
        await waitForWritableDrain(res);
      }
    }
    res.end();
  } catch (error) {
    res.destroy(error instanceof Error ? error : new Error(String(error)));
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Enhance a Node.js req/res pair with Next.js API route helpers.
 */
function enhanceApiObjects(
  req: IncomingMessage,
  res: ServerResponse,
  query: Record<string, string | string[]>,
  body: unknown,
): { apiReq: NextApiRequest; apiRes: NextApiResponse } {
  const apiReq = Object.assign(req, {
    body,
    query,
  }) as NextApiRequest;
  attachPagesRequestCookies(apiReq);

  const apiRes = Object.assign(res, {
    status(this: NextApiResponse, code: number) {
      this.statusCode = code;
      return this;
    },

    json(this: NextApiResponse, data: unknown) {
      this.setHeader("Content-Type", "application/json");
      this.end(JSON.stringify(data));
    },

    send(this: NextApiResponse, data: unknown) {
      if (Buffer.isBuffer(data)) {
        if (!this.getHeader("Content-Type")) {
          this.setHeader("Content-Type", "application/octet-stream");
        }
        this.setHeader("Content-Length", String(data.length));
        this.end(data);
        return;
      }

      if (typeof data === "object" && data !== null) {
        this.setHeader("Content-Type", "application/json");
        this.end(JSON.stringify(data));
      } else {
        if (!this.getHeader("Content-Type")) {
          this.setHeader("Content-Type", "text/plain");
        }
        this.end(String(data));
      }
    },

    redirect(this: NextApiResponse, statusOrUrl: number | string, url?: string) {
      if (typeof statusOrUrl === "string") {
        url = statusOrUrl;
        statusOrUrl = 307;
      }
      if (typeof statusOrUrl !== "number" || typeof url !== "string") {
        throw new Error(
          "Invalid redirect arguments. Please use a single argument URL, e.g. res.redirect('/destination') or use a status code and URL, e.g. res.redirect(307, '/destination').",
        );
      }
      this.writeHead(statusOrUrl, { Location: url });
      this.write(url);
      this.end();
      return this;
    },

    // `res.revalidate(urlPath)` triggers on-demand ISR regeneration of a Pages
    // Router route. Delegates to the shared helper so the secret wiring and
    // success detection stay identical to the dev/Node-compat path. See
    // `pages-revalidate.ts`.
    async revalidate(this: NextApiResponse, urlPath: string, opts?: RevalidateOptions) {
      await performOnDemandRevalidate(req, urlPath, opts);
    },
  }) as NextApiResponse;
  attachPagesPreviewApi(
    apiReq as unknown as PagesReqResRequest,
    apiRes as unknown as PagesReqResResponse,
  );

  return { apiReq, apiRes };
}

/**
 * Handle an API route request.
 * Returns true if the request was handled, false if no API route matched.
 */
export async function handleApiRoute(
  runner: ModuleImporter,
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  apiRoutes: Route[],
  nextConfig?: {
    basePath?: string;
    i18n?: NextI18nConfig | null;
    trailingSlash?: boolean;
  },
): Promise<boolean> {
  const match = matchRoute(url, apiRoutes);
  if (!match) return false;

  const { route, params } = match;

  try {
    // Load the API route module through the ModuleRunner
    const apiModule = await importModule(runner, route.filePath);
    if (isEdgeApiRouteModule(apiModule)) {
      // Next.js wraps the incoming Request in a NextRequest before invoking
      // edge API handlers, so handlers can use `req.nextUrl.searchParams`,
      // `req.cookies`, etc. (Cf. NextRequestHint in next/src/server/web/adapter.ts.)
      const nextRequest = new NextRequest(
        createEdgeApiRequest(req, url, params, nextConfig),
        nextConfig
          ? {
              nextConfig: {
                basePath: nextConfig.basePath,
                i18n: nextConfig.i18n ?? undefined,
                trailingSlash: nextConfig.trailingSlash,
              },
            }
          : undefined,
      );
      const response = await apiModule.default(nextRequest);
      if (!(response instanceof Response)) {
        throw new Error("Edge API route did not return a Response");
      }

      res.statusCode = response.status;
      res.statusMessage = response.statusText;
      const setCookieHeaders = response.headers.getSetCookie();
      response.headers.forEach((value, name) => {
        if (name !== "set-cookie") res.setHeader(name, value);
      });
      if (setCookieHeaders.length) {
        res.setHeader("set-cookie", setCookieHeaders);
      }
      await writeEdgeApiResponseBody(res, response.body);
      return true;
    }

    const handler = apiModule.default;
    if (typeof handler !== "function") {
      console.error(`[vinext] API route ${route.filePath} does not export a default function`);
      res.statusCode = 500;
      res.end("API route does not export a default function");
      return true;
    }

    // Parse query from URL + route params. Path params win over same-key search
    // params so a query string cannot change the dynamic route value.
    const query = mergeRouteParamsIntoQuery(parseQueryString(url), params);

    // Honour `export const config = { api: { bodyParser: ... } }` on the
    // route module. When the handler opts out (`bodyParser: false`) we must
    // not consume the stream — leave `req` intact so user code (e.g. a
    // Stripe/GitHub webhook) can read the raw bytes for HMAC verification.
    const bodyParserConfig = resolveBodyParserConfig(
      (apiModule as { config?: { api?: { bodyParser?: unknown } } }).config as
        | { api?: { bodyParser?: boolean | { sizeLimit?: string | number } } }
        | undefined,
    );

    const body = bodyParserConfig.enabled
      ? await parseBody(req, bodyParserConfig.sizeLimit)
      : undefined;

    // Enhance req/res with Next.js helpers
    const { apiReq, apiRes } = enhanceApiObjects(req, res, query, body);

    // Call the handler
    await handler(apiReq, apiRes);
    return true;
  } catch (e) {
    if (e instanceof PagesBodyParseError) {
      res.statusCode = e.statusCode;
      res.statusMessage = e.message;
      res.end(e.message);
      return true;
    }

    // ssrFixStacktrace() is specific to ssrLoadModule and is not applicable
    // when using ModuleRunner — no stack trace fixup is needed here.
    console.error(e);
    void reportRequestError(
      e instanceof Error ? e : new Error(String(e)),
      {
        path: url,
        method: req.method ?? "GET",
        headers: Object.fromEntries(
          Object.entries(req.headers)
            // Exclude HTTP/2 pseudo-headers (RFC 7540 §8.1.2.1) — they are not
            // real request headers. See: cloudflare/vinext#2013
            .filter(([k]) => !k.startsWith(":"))
            .map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v ?? "")]),
        ),
      },
      { routerKind: "Pages Router", routePath: match.route.pattern, routeType: "route" },
    );
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end("Internal Server Error");
    } else if (!res.writableEnded) {
      res.end();
    }
    return true;
  }
}
