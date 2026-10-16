import { decode as decodeQueryString } from "node:querystring";
import { Readable, Writable } from "node:stream";
import { parseCookieHeader } from "../utils/parse-cookie.js";
import { readStreamAsTextWithLimit } from "../utils/text-stream.js";
import { DEFAULT_PAGES_API_BODY_SIZE_LIMIT } from "./pages-body-parser-config.js";
import { PagesBodyParseError, getMediaType, isJsonMediaType } from "./pages-media-type.js";
import { performOnDemandRevalidate, type RevalidateOptions } from "./pages-revalidate.js";
import {
  clearPagesPreviewData,
  getPagesPreviewState,
  setPagesDraftMode,
  setPagesPreviewData,
  type PagesPreviewData,
} from "./pages-preview.js";

const MAX_PAGES_API_BODY_SIZE = DEFAULT_PAGES_API_BODY_SIZE_LIMIT;
// Next.js's Node sendData() strips bodies for 204/304. Fetch additionally
// forbids a body for 205, so the Worker adapter must normalize that status too.
const NO_BODY_RESPONSE_STATUSES = new Set([204, 205, 304]);

/**
 * @deprecated Use PagesBodyParseError from pages-media-type.ts instead.
 * Kept for backwards compatibility.
 */
export { PagesBodyParseError as PagesApiBodyParseError };

export type PagesRequestQuery = Record<string, string | string[]>;

export type PagesReqResRequest = Readable & {
  method: string;
  url: string;
  headers: Record<string, string>;
  query: PagesRequestQuery;
  body: unknown;
  cookies: Record<string, string>;
  preview?: true;
  draftMode?: true;
  previewData: PagesPreviewData | false;
};

// Like @types/node's OutgoingHttpHeader, arrays are typed as string[] even
// though appending to a number or boolean keeps that scalar in the list.
type PagesReqResHeaderValue = string | number | boolean | string[];

type PagesReqResHeaders = {
  [key: string]: PagesReqResHeaderValue;
};

// Node's http validateHeaderName/validateHeaderValue rules.
const HTTP_TOKEN_PATTERN = /^[\^_`a-zA-Z\-0-9!#$%&'*+.|~]+$/;
const INVALID_HEADER_VALUE_CHAR_PATTERN = /[^\t\x20-\x7e\x80-\xff]/;

function createNodeTypeError(code: string, message: string): TypeError {
  return Object.assign(new TypeError(message), { code });
}

function validateAppendedHeader(name: string, value: string | readonly string[]): void {
  if (typeof name !== "string" || !name || !HTTP_TOKEN_PATTERN.test(name)) {
    throw createNodeTypeError(
      "ERR_INVALID_HTTP_TOKEN",
      `Header name must be a valid HTTP token ["${String(name)}"]`,
    );
  }
  for (const item of Array.isArray(value) ? value : [value]) {
    if (item === undefined) {
      throw createNodeTypeError(
        "ERR_HTTP_INVALID_HEADER_VALUE",
        `Invalid value "undefined" for header "${name}"`,
      );
    }
    if (INVALID_HEADER_VALUE_CHAR_PATTERN.test(String(item))) {
      throw createNodeTypeError(
        "ERR_INVALID_CHAR",
        `Invalid character in header content ["${name}"]`,
      );
    }
  }
}

export type PagesReqResResponse = Writable & {
  statusCode: number;
  readonly headersSent: boolean;
  writeHead: (code: number, headers?: PagesReqResHeaders) => PagesReqResResponse;
  setHeader: (name: string, value: PagesReqResHeaderValue) => PagesReqResResponse;
  appendHeader: (name: string, value: string | readonly string[]) => PagesReqResResponse;
  getHeader: (name: string) => PagesReqResHeaderValue | undefined;
  status: (code: number) => PagesReqResResponse;
  json: (data: unknown) => void;
  send: (data: unknown) => void;
  redirect: (statusOrUrl: number | string, url?: string) => PagesReqResResponse;
  getHeaders: () => PagesReqResHeaders;
  setPreviewData: (
    data: object | string,
    options?: { maxAge?: number; path?: string },
  ) => PagesReqResResponse;
  clearPreviewData: (options?: { path?: string }) => PagesReqResResponse;
  setDraftMode: (options?: { enable?: boolean }) => PagesReqResResponse;
};

export type PagesApiReqResResponse = PagesReqResResponse & {
  revalidate: (urlPath: string, opts?: RevalidateOptions) => Promise<void>;
};

type PagesRequestCookiesCarrier = {
  headers: {
    cookie?: string | string[] | null | undefined;
  };
  cookies?: unknown;
};

type CreatePagesReqResOptions = {
  body: unknown;
  initialResponseHeaders?: Headers;
  query: PagesRequestQuery;
  request: Request;
  url: string;
};

type CreatePagesApiReqResOptions = CreatePagesReqResOptions & {
  allowedRevalidateHeaderKeys?: readonly string[];
  trustedRevalidateOrigin?: string;
};

type CreatePagesReqResResult<Res extends PagesReqResResponse = PagesReqResResponse> = {
  req: PagesReqResRequest;
  res: Res;
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

async function* requestBodyChunks(request: Request): AsyncGenerator<Buffer> {
  if (!request.body || request.bodyUsed) {
    return;
  }

  const reader = request.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        return;
      }
      // Node `IncomingMessage` yields `Buffer` chunks, not `Uint8Array`:
      // handler code routinely calls `chunk.toString("utf8")`, which on a
      // raw Uint8Array comma-joins the byte values instead of decoding.
      // Buffer.from(buffer, offset, length) is a zero-copy view.
      yield Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Ignore cancellation errors from the upstream source.
    }
    reader.releaseLock();
  }
}

function createRequestReadable(request: Request): Readable {
  // `Readable.from` defaults to objectMode — opt out so the request is a
  // byte stream like `IncomingMessage` (`setEncoding()`/`read(n)` byte
  // semantics, byte-based highWaterMark).
  return Readable.from(requestBodyChunks(request), { objectMode: false });
}

function parsePagesRequestCookies(cookieHeader: string | string[] | null | undefined) {
  return parseCookieHeader(Array.isArray(cookieHeader) ? cookieHeader.join("; ") : cookieHeader);
}

export function attachPagesRequestCookies(req: PagesRequestCookiesCarrier): void {
  if (Object.hasOwn(req, "cookies")) return;

  Object.defineProperty(req, "cookies", {
    configurable: true,
    enumerable: true,
    get() {
      const cookies = parsePagesRequestCookies(req.headers.cookie);
      Object.defineProperty(req, "cookies", {
        configurable: true,
        enumerable: true,
        value: cookies,
        writable: true,
      });
      return cookies;
    },
    set(value: unknown) {
      Object.defineProperty(req, "cookies", {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      });
    },
  });
}

export function attachPagesPreviewApi(req: PagesReqResRequest, res: PagesReqResResponse): void {
  const preview = getPagesPreviewState(req.headers.cookie);
  req.previewData = preview.data;
  if (preview.data !== false) {
    req.preview = true;
    req.draftMode = true;
  }
  res.setPreviewData = (data, options = {}) => {
    setPagesPreviewData(res, data, options);
    return res;
  };
  res.clearPreviewData = (options = {}) => {
    clearPagesPreviewData(res, options);
    return res;
  };
  res.setDraftMode = (options = { enable: true }) => {
    setPagesDraftMode(res, options.enable !== false);
    return res;
  };
  if (preview.shouldClear) clearPagesPreviewData(res);
}

class PagesResponseStream extends Writable {
  private resStatusCode = 200;
  // Null-prototype like Node's header map, so names such as `constructor` or
  // `__proto__` are ordinary headers.
  private readonly resHeaders: PagesReqResHeaders = Object.create(null);
  private resolved = false;
  // Node's ServerResponse commits its head on writeHead(), not only on the
  // first body write.
  private headWritten = false;
  private controller: ReadableStreamDefaultController | null = null;
  private readonly bufferedChunks: Buffer[] = [];
  private streamEnded = false;
  private pendingWrite: ((error?: Error | null) => void) | null = null;
  private discardBody = false;

  constructor(
    private readonly resolveResponse: (value: Response) => void,
    private readonly rejectResponse: (error: Error) => void,
  ) {
    super();
    this.once("error", (err) => {
      if (!this.resolved) {
        this.resolved = true;
        this.rejectResponse(err);
      }
    });
  }

  get statusCode(): number {
    return this.resStatusCode;
  }

  set statusCode(code: number) {
    this.resStatusCode = code;
  }

  get headersSent(): boolean {
    return this.writableEnded || this.resolved;
  }

  writeHead(code: number, headers?: PagesReqResHeaders): PagesReqResResponse {
    this.resStatusCode = code;
    if (headers) {
      for (const [key, value] of Object.entries(headers)) {
        this.setHeaderValue(key, value, { append: false });
      }
    }
    this.headWritten = true;
    return this as PagesReqResResponse;
  }

  setHeader(name: string, value: PagesReqResHeaderValue): PagesReqResResponse {
    this.setHeaderValue(name, value, { append: false });
    return this as PagesReqResResponse;
  }

  // Node's ServerResponse.appendHeader (Node 18.3+): adds to any existing
  // value instead of replacing it.
  appendHeader(name: string, value: string | readonly string[]): PagesReqResResponse {
    if (this.headWritten || this.headersSent) {
      // The Response headers were snapshotted on the first write, so a late
      // append would be silently dropped. Node throws here.
      throw Object.assign(new Error("Cannot append headers after they are sent to the client"), {
        code: "ERR_HTTP_HEADERS_SENT",
      });
    }
    // Node validates at the call site, so handlers can catch the error.
    validateAppendedHeader(name, value);
    this.setHeaderValue(name, value, { append: true });
    return this as PagesReqResResponse;
  }

  getHeader(name: string): PagesReqResHeaderValue | undefined {
    return this.resHeaders[name.toLowerCase()];
  }

  status(code: number): PagesReqResResponse {
    this.resStatusCode = code;
    return this as PagesReqResResponse;
  }

  json(data: unknown): void {
    this.resHeaders["content-type"] = "application/json";
    this.end(JSON.stringify(data));
  }

  send(data: unknown): void {
    if (Buffer.isBuffer(data)) {
      if (!this.resHeaders["content-type"]) {
        this.resHeaders["content-type"] = "application/octet-stream";
      }
      this.resHeaders["content-length"] = String(data.length);
      this.end(data);
      return;
    }

    if (typeof data === "object" && data !== null) {
      this.resHeaders["content-type"] = "application/json";
      this.end(JSON.stringify(data));
      return;
    }

    if (!this.resHeaders["content-type"]) {
      this.resHeaders["content-type"] = "text/plain";
    }
    this.end(String(data));
  }

  redirect(statusOrUrl: number | string, url?: string): PagesReqResResponse {
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
    return this as PagesReqResResponse;
  }

  getHeaders(): PagesReqResHeaders {
    return { ...this.resHeaders };
  }

  setPreviewData(
    data: object | string,
    options: { maxAge?: number; path?: string } = {},
  ): PagesReqResResponse {
    setPagesPreviewData(this, data, options);
    return this as PagesReqResResponse;
  }

  clearPreviewData(options: { path?: string } = {}): PagesReqResResponse {
    clearPagesPreviewData(this, options);
    return this as PagesReqResResponse;
  }

  setDraftMode(options: { enable?: boolean } = { enable: true }): PagesReqResResponse {
    setPagesDraftMode(this, options.enable !== false);
    return this as PagesReqResResponse;
  }

  override _write(
    chunk: Uint8Array | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.discardBody) {
      callback();
      return;
    }
    const buffer = typeof chunk === "string" ? Buffer.from(chunk, encoding) : Buffer.from(chunk);
    if (this.controller && !this.streamEnded) {
      try {
        this.controller.enqueue(buffer);
      } catch {
        // Controller closed — consumer cancelled or stream finished
      }
    } else {
      this.bufferedChunks.push(buffer);
    }
    this.resolveOnce();
    // Propagate consumer backpressure to the Node source: while the response
    // body's queue is full, hold the write callback until the consumer pulls.
    // A held callback makes `write()` return false, which pauses any piped
    // source (e.g. a proxied upstream) instead of queueing chunks without
    // bound. `end(data)` writes can park here too because Node sets
    // writableEnded after _write returns; the adapter's first body pull
    // releases them, and the completed response remains on the buffered path.
    if (
      this.controller &&
      !this.streamEnded &&
      !this.writableEnded &&
      (this.controller.desiredSize ?? 1) <= 0
    ) {
      this.pendingWrite = callback;
    } else {
      callback();
    }
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.streamEnded = true;
    if (this.controller) {
      try {
        this.controller.close();
      } catch {
        // Already closed
      }
    }
    this.resolveOnce();
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.streamEnded = true;
    // A write parked for backpressure would otherwise never complete; release
    // it so piped sources unwind instead of waiting on a dead stream.
    this.releasePendingWrite(error);
    if (!this.resolved) {
      if (error) {
        this.resolved = true;
        this.rejectResponse(error);
      } else {
        this.resolveOnce();
      }
    }
    if (this.controller) {
      try {
        if (error) {
          this.controller.error(error);
        } else {
          this.controller.close();
        }
      } catch {
        // Already closed or errored
      }
    }
    callback(error);
  }

  private setHeaderValue(
    name: string,
    value: PagesReqResHeaderValue | readonly string[],
    options: { append: boolean },
  ): void {
    const key = name.toLowerCase();
    // Like Node, keep header arrays (and appended values) as a list of the
    // original values so getHeader() returns every value in its own type.
    const existing = this.resHeaders[key];
    if (!options.append || existing === undefined) {
      // Node keeps the caller's array itself, so later pushes to it (and later
      // appends) are emitted too.
      this.resHeaders[key] = value as PagesReqResHeaderValue;
      return;
    }
    const values = (Array.isArray(existing) ? existing : [existing]) as string[];
    values.push(...((Array.isArray(value) ? value : [value]) as string[]));
    this.resHeaders[key] = values;
  }

  private releasePendingWrite(error?: Error | null): void {
    const callback = this.pendingWrite;
    this.pendingWrite = null;
    callback?.(error);
  }

  private resolveOnce(): void {
    if (this.resolved) {
      return;
    }
    this.resolved = true;

    const headers = new Headers();
    for (const [key, value] of Object.entries(this.resHeaders)) {
      if (Array.isArray(value)) {
        for (const item of value) headers.append(key, String(item));
      } else {
        headers.set(key, String(value));
      }
    }

    // Fetch rejects a Response that pairs 204/205/304 with any body, including
    // an empty ReadableStream. Node's ServerResponse accepts `res.status(204).end()`,
    // so preserve that API while matching Next.js's sendData() cleanup for
    // bodyless statuses.
    if (NO_BODY_RESPONSE_STATUSES.has(this.resStatusCode)) {
      this.discardBody = true;
      this.bufferedChunks.length = 0;
      headers.delete("content-length");
      headers.delete("content-type");
      headers.delete("transfer-encoding");
      this.resolveResponse(new Response(null, { status: this.resStatusCode, headers }));
      return;
    }

    const stream = new ReadableStream({
      start: (controller) => {
        this.controller = controller;
        for (const buffer of this.bufferedChunks) {
          try {
            controller.enqueue(buffer);
          } catch {
            // Controller closed, ignore
          }
        }
        this.bufferedChunks.length = 0;
        if (this.streamEnded) {
          try {
            controller.close();
          } catch {
            // Already closed
          }
        }
      },
      pull: () => {
        this.releasePendingWrite();
      },
      cancel: (reason) => {
        this.bufferedChunks.length = 0;
        this.destroy(reason instanceof Error ? reason : new Error("Response body cancelled"));
      },
    });

    this.resolveResponse(new Response(stream, { status: this.resStatusCode, headers }));
  }
}

type ResponseWithVinextStreamedApiBody = Response & {
  __vinextStreamedApiResponse?: boolean;
};

/**
 * Marks a Pages API Response whose body was still being written when the
 * handler settled (streaming/piping), so Node adapters forward it as a stream.
 * Buffering a live stream would defer delivery until the source closes and
 * hold the whole body in memory. Complete bodies (`res.json`, `res.send`,
 * `res.end(data)`) are not marked and keep the buffered path, which preserves
 * Content-Length.
 */
export function markVinextStreamedApiResponse(response: Response): void {
  (response as ResponseWithVinextStreamedApiBody).__vinextStreamedApiResponse = true;
}

export function isVinextStreamedApiResponse(response: Response): boolean {
  return (response as ResponseWithVinextStreamedApiBody).__vinextStreamedApiResponse === true;
}

export function createPagesReqRes(options: CreatePagesReqResOptions): CreatePagesReqResResult {
  const headersObj: Record<string, string> = {};
  for (const [key, value] of options.request.headers) {
    headersObj[key.toLowerCase()] = value;
  }

  // Next.js Pages API routes receive Node IncomingMessage/ServerResponse
  // objects. The Workers/prod adapter starts from a Fetch Request, so expose a
  // real Readable here instead of a plain object. That keeps both documented
  // raw-body iteration and legacy stream proxying (`req.pipe(...)`) working.
  const req = Object.assign(createRequestReadable(options.request), {
    method: options.request.method,
    url: options.url,
    headers: headersObj,
    query: options.query,
    body: options.body,
  }) as PagesReqResRequest;
  attachPagesRequestCookies(req);

  let resolveResponse!: (value: Response) => void;
  let rejectResponse!: (error: Error) => void;
  const responsePromise = new Promise<Response>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  const res: PagesReqResResponse = new PagesResponseStream(
    resolveResponse,
    rejectResponse,
  ) as PagesReqResResponse;
  for (const [name, value] of options.initialResponseHeaders ?? []) {
    if (name.toLowerCase() === "set-cookie") continue;
    res.setHeader(name, value);
  }
  const initialCookies = options.initialResponseHeaders?.getSetCookie() ?? [];
  if (initialCookies.length > 0) res.setHeader("Set-Cookie", initialCookies);
  attachPagesPreviewApi(req, res);

  return { req, res, responsePromise };
}

/**
 * Create the req/res pair for a Pages API route. Only API responses get
 * `res.revalidate()`: Next.js attaches it in apiResolver
 * (`packages/next/src/server/api-utils/node/api-resolver.ts`), so a page's
 * getServerSideProps `res` never carries the revalidation secret.
 */
export function createPagesApiReqRes(
  options: CreatePagesApiReqResOptions,
): CreatePagesReqResResult<PagesApiReqResResponse> {
  const { req, res, responsePromise } = createPagesReqRes(options);
  // Fetch runtimes do not expose a listening socket origin. Fall back to the
  // platform-provided Request URL origin and deliberately ignore any raw Host
  // header carried in request.headers.
  const trustedRevalidateOrigin =
    options.trustedRevalidateOrigin ?? new URL(options.request.url).origin;
  const apiRes = Object.assign(res, {
    async revalidate(urlPath: string, opts?: RevalidateOptions): Promise<void> {
      await performOnDemandRevalidate(
        options.request.headers,
        urlPath,
        opts,
        trustedRevalidateOrigin,
        options.allowedRevalidateHeaderKeys,
      );
    },
  });
  return { req, res: apiRes, responsePromise };
}
