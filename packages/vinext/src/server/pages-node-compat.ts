import { decode as decodeQueryString } from "node:querystring";
import { parseCookies } from "../config/config-matchers.js";
import { readStreamAsTextWithLimit } from "../utils/text-stream.js";
import { DEFAULT_PAGES_API_BODY_SIZE_LIMIT } from "./pages-body-parser-config.js";
import { PagesBodyParseError, getMediaType, isJsonMediaType } from "./pages-media-type.js";
import { performOnDemandRevalidate, type RevalidateOptions } from "./pages-revalidate.js";

const MAX_PAGES_API_BODY_SIZE = DEFAULT_PAGES_API_BODY_SIZE_LIMIT;

/**
 * @deprecated Use PagesBodyParseError from pages-media-type.ts instead.
 * Kept for backwards compatibility.
 */
export { PagesBodyParseError as PagesApiBodyParseError };

export type PagesRequestQuery = Record<string, string | string[]>;

export type PagesReqResRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  query: PagesRequestQuery;
  body: unknown;
  cookies: Record<string, string>;
  /**
   * Async-iterator hook so handlers can `for await (const chunk of req)` —
   * matching Node's `IncomingMessage` contract. Critical for the
   * `bodyParser: false` opt-out (webhook signature verification etc.) where
   * `req.body` is left undefined and user code is expected to drain the raw
   * stream off `req` itself.
   */
  [Symbol.asyncIterator]: () => AsyncIterator<Uint8Array>;
};

type PagesReqResHeaders = {
  [key: string]: string | number | boolean | string[];
};

export type PagesReqResResponse = {
  statusCode: number;
  readonly headersSent: boolean;
  writeHead: (code: number, headers?: PagesReqResHeaders) => PagesReqResResponse;
  setHeader: (name: string, value: string | number | boolean | string[]) => PagesReqResResponse;
  getHeader: (name: string) => string | number | boolean | string[] | undefined;
  end: (data?: BodyInit | null) => void;
  status: (code: number) => PagesReqResResponse;
  json: (data: unknown) => void;
  send: (data: unknown) => void;
  redirect: (statusOrUrl: number | string, url?: string) => void;
  getHeaders: () => PagesReqResHeaders;
  revalidate: (urlPath: string, opts?: RevalidateOptions) => Promise<void>;
};

type CreatePagesReqResOptions = {
  body: unknown;
  query: PagesRequestQuery;
  request: Request;
  url: string;
};

type CreatePagesReqResResult = {
  req: PagesReqResRequest;
  res: PagesReqResResponse;
  responsePromise: Promise<Response>;
};

async function readPagesRequestBodyWithLimit(request: Request, maxBytes: number): Promise<string> {
  if (!request.body) {
    return "";
  }

  return readStreamAsTextWithLimit(request.body, maxBytes, () => {
    throw new PagesBodyParseError("Request body too large", 413);
  });
}

/**
 * Read and parse a Pages Router API request body for the Workers/prod path.
 *
 * `maxBytes` defaults to the 1 MB Next.js default but may be overridden by
 * `export const config = { api: { bodyParser: { sizeLimit: '4mb' } } }` on
 * the route module. Handlers that opt out entirely (`bodyParser: false`)
 * MUST skip this function so the body stream stays intact for user code.
 *
 * @see https://nextjs.org/docs/pages/building-your-application/routing/api-routes#custom-config
 */
export async function parsePagesApiBody(
  request: Request,
  maxBytes = MAX_PAGES_API_BODY_SIZE,
): Promise<unknown> {
  const contentLength = Number.parseInt(request.headers.get("content-length") || "0", 10);
  if (contentLength > maxBytes) {
    throw new PagesBodyParseError("Request body too large", 413);
  }

  let rawBody = "";
  try {
    rawBody = await readPagesRequestBodyWithLimit(request, maxBytes);
  } catch (err) {
    if (err instanceof PagesBodyParseError) {
      throw err;
    }
    throw new PagesBodyParseError("Request body too large", 413);
  }

  const mediaType = getMediaType(request.headers.get("content-type"));
  if (!rawBody) {
    return isJsonMediaType(mediaType)
      ? {}
      : mediaType === "application/x-www-form-urlencoded"
        ? decodeQueryString(rawBody)
        : undefined;
  }

  if (isJsonMediaType(mediaType)) {
    try {
      return JSON.parse(rawBody);
    } catch {
      throw new PagesBodyParseError("Invalid JSON", 400);
    }
  }

  if (mediaType === "application/x-www-form-urlencoded") {
    return decodeQueryString(rawBody);
  }

  return rawBody;
}

export function createPagesReqRes(options: CreatePagesReqResOptions): CreatePagesReqResResult {
  const headersObj: Record<string, string> = {};
  for (const [key, value] of options.request.headers) {
    headersObj[key.toLowerCase()] = value;
  }

  // Surface the raw request body as an async-iterator on `req` so handlers
  // can do `for await (const chunk of req)`, matching Node's
  // `IncomingMessage` contract. This is the documented escape hatch when
  // `bodyParser: false` is set (Stripe/GitHub/Slack webhooks need the raw
  // bytes for HMAC signature verification).
  //
  // Cf. Next.js test/e2e/middleware-fetches-with-body fixture
  // `body_parser_false.js`, which calls `for await (const chunk of req)`
  // on the `IncomingMessage`-shaped req object. See issue #1479.
  const requestBody = options.request.body;
  const reqAsyncIterator = (): AsyncIterator<Uint8Array> => {
    if (!requestBody) {
      // No body — yield nothing. Use an inert iterator so `for await` is
      // a no-op rather than throwing.
      return {
        next(): Promise<IteratorResult<Uint8Array>> {
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    }
    const reader = requestBody.getReader();
    return {
      async next(): Promise<IteratorResult<Uint8Array>> {
        const { value, done } = await reader.read();
        if (done) {
          return { value: undefined, done: true };
        }
        return { value, done: false };
      },
      async return(): Promise<IteratorResult<Uint8Array>> {
        // `for await ... break` path — release the lock so the stream is
        // discardable. Cancellation propagates to the underlying source.
        try {
          await reader.cancel();
        } catch {
          // Ignore errors during cancellation.
        }
        return { value: undefined, done: true };
      },
    };
  };

  const req: PagesReqResRequest = {
    method: options.request.method,
    url: options.url,
    headers: headersObj,
    query: options.query,
    body: options.body,
    cookies: parseCookies(options.request.headers.get("cookie")),
    [Symbol.asyncIterator]: reqAsyncIterator,
  };

  let resStatusCode = 200;
  const resHeaders: Record<string, string | number | boolean> = {};
  const setCookieHeaders: string[] = [];
  let resBody: BodyInit | null = null;
  let ended = false;
  let resolveResponse!: (value: Response) => void;
  const responsePromise = new Promise<Response>((resolve) => {
    resolveResponse = resolve;
  });

  const res: PagesReqResResponse = {
    get statusCode() {
      return resStatusCode;
    },
    set statusCode(code) {
      resStatusCode = code;
    },
    get headersSent() {
      return ended;
    },
    writeHead(code, headers) {
      resStatusCode = code;
      if (headers) {
        for (const [key, value] of Object.entries(headers)) {
          if (key.toLowerCase() === "set-cookie") {
            if (Array.isArray(value)) {
              setCookieHeaders.push(...value.map(String));
            } else {
              setCookieHeaders.push(String(value));
            }
          } else {
            resHeaders[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
          }
        }
      }
      return res;
    },
    setHeader(name, value) {
      if (name.toLowerCase() === "set-cookie") {
        // Node.js res.setHeader() replaces the existing value entirely.
        setCookieHeaders.length = 0;
        if (Array.isArray(value)) {
          setCookieHeaders.push(...value.map(String));
        } else {
          setCookieHeaders.push(String(value));
        }
      } else {
        resHeaders[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
      }
      return res;
    },
    getHeader(name) {
      if (name.toLowerCase() === "set-cookie") {
        return setCookieHeaders.length > 0 ? setCookieHeaders : undefined;
      }
      return resHeaders[name.toLowerCase()];
    },
    end(data) {
      if (ended) {
        return;
      }
      ended = true;
      if (data !== undefined && data !== null) {
        resBody = data;
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(resHeaders)) {
        headers.set(key, String(value));
      }
      for (const cookie of setCookieHeaders) {
        headers.append("set-cookie", cookie);
      }
      resolveResponse(new Response(resBody, { status: resStatusCode, headers }));
    },
    status(code) {
      resStatusCode = code;
      return res;
    },
    json(data) {
      resHeaders["content-type"] = "application/json";
      res.end(JSON.stringify(data));
    },
    send(data) {
      if (Buffer.isBuffer(data)) {
        if (!resHeaders["content-type"]) {
          resHeaders["content-type"] = "application/octet-stream";
        }
        resHeaders["content-length"] = String(data.length);
        res.end(new Uint8Array(data));
        return;
      }

      if (typeof data === "object" && data !== null) {
        resHeaders["content-type"] = "application/json";
        res.end(JSON.stringify(data));
        return;
      }

      if (!resHeaders["content-type"]) {
        resHeaders["content-type"] = "text/plain";
      }
      res.end(String(data));
    },
    redirect(statusOrUrl, url) {
      if (typeof statusOrUrl === "string") {
        res.writeHead(307, { Location: statusOrUrl });
      } else {
        res.writeHead(statusOrUrl, { Location: url ?? "" });
      }
      res.end();
    },
    getHeaders() {
      const headers: PagesReqResHeaders = { ...resHeaders };
      if (setCookieHeaders.length > 0) {
        headers["set-cookie"] = setCookieHeaders;
      }
      return headers;
    },

    // `res.revalidate(urlPath)` triggers on-demand ISR regeneration of a Pages
    // Router route. Delegates to the shared helper so the secret wiring and
    // success detection stay identical to the prod (`api-handler.ts`) path. See
    // `pages-revalidate.ts`.
    async revalidate(urlPath, opts) {
      await performOnDemandRevalidate(options.request.headers, urlPath, opts);
    },
  };

  return { req, res, responsePromise };
}
