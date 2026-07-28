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

type PagesReqResHeaders = {
  [key: string]: string | number | boolean | string[];
};

export type PagesReqResResponse = Writable & {
  statusCode: number;
  readonly headersSent: boolean;
  writeHead: (code: number, headers?: PagesReqResHeaders) => PagesReqResResponse;
  setHeader: (name: string, value: string | number | boolean | string[]) => PagesReqResResponse;
  getHeader: (name: string) => string | number | boolean | string[] | undefined;
  status: (code: number) => PagesReqResResponse;
  json: (data: unknown) => void;
  send: (data: unknown) => void;
  redirect: (statusOrUrl: number | string, url?: string) => PagesReqResResponse;
  getHeaders: () => PagesReqResHeaders;
  revalidate: (urlPath: string, opts?: RevalidateOptions) => Promise<void>;
  setPreviewData: (
    data: object | string,
    options?: { maxAge?: number; path?: string },
  ) => PagesReqResResponse;
  clearPreviewData: (options?: { path?: string }) => PagesReqResResponse;
  setDraftMode: (options?: { enable?: boolean }) => PagesReqResResponse;
};

type PagesRequestCookiesCarrier = {
  headers: {
    cookie?: string | string[] | null | undefined;
  };
  cookies?: unknown;
};

type CreatePagesReqResOptions = {
  allowedRevalidateHeaderKeys?: readonly string[];
  body: unknown;
  query: PagesRequestQuery;
  request: Request;
  trustedRevalidateOrigin?: string;
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

function getPagesPreviewDataFromCookieHeader(
  cookieHeader: string | string[] | null | undefined,
  options: { isOnDemandRevalidate?: boolean } = {},
): PagesPreviewData | false {
  return getPagesPreviewState(cookieHeader, options).data;
}

export function getPagesPreviewData(
  request: Request,
  options: { isOnDemandRevalidate?: boolean } = {},
): PagesPreviewData | false {
  return getPagesPreviewDataFromCookieHeader(request.headers.get("cookie"), options);
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
  private readonly resHeaders: Record<string, string | number | boolean> = {};
  private readonly setCookieHeaders: string[] = [];
  private resolved = false;
  private controller: ReadableStreamDefaultController | null = null;
  private readonly bufferedChunks: Buffer[] = [];
  private streamEnded = false;

  constructor(
    private readonly resolveResponse: (value: Response) => void,
    private readonly rejectResponse: (error: Error) => void,
    private readonly requestHeaders: Headers,
    private readonly trustedRevalidateOrigin?: string,
    private readonly allowedRevalidateHeaderKeys: readonly string[] = [],
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
        this.setHeaderValue(key, value, { replaceSetCookie: true });
      }
    }
    return this as PagesReqResResponse;
  }

  setHeader(name: string, value: string | number | boolean | string[]): PagesReqResResponse {
    this.setHeaderValue(name, value, { replaceSetCookie: true });
    return this as PagesReqResResponse;
  }

  getHeader(name: string): string | number | boolean | string[] | undefined {
    if (name.toLowerCase() === "set-cookie") {
      return this.setCookieHeaders.length > 0 ? this.setCookieHeaders : undefined;
    }
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
    const headers: PagesReqResHeaders = { ...this.resHeaders };
    if (this.setCookieHeaders.length > 0) {
      headers["set-cookie"] = this.setCookieHeaders;
    }
    return headers;
  }

  async revalidate(urlPath: string, opts?: RevalidateOptions): Promise<void> {
    await performOnDemandRevalidate(
      this.requestHeaders,
      urlPath,
      opts,
      this.trustedRevalidateOrigin,
      this.allowedRevalidateHeaderKeys,
    );
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
    callback();
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
    value: string | number | boolean | string[],
    options: { replaceSetCookie: boolean },
  ): void {
    if (name.toLowerCase() === "set-cookie") {
      // getHeader() exposes this array like Node's ServerResponse. Snapshot it
      // before replacement so passing that live value back does not clear it.
      const values = Array.isArray(value) ? value.map(String) : [String(value)];
      if (options.replaceSetCookie) {
        this.setCookieHeaders.length = 0;
      }
      this.setCookieHeaders.push(...values);
      return;
    }

    this.resHeaders[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }

  private resolveOnce(): void {
    if (this.resolved) {
      return;
    }
    this.resolved = true;

    const headers = new Headers();
    for (const [key, value] of Object.entries(this.resHeaders)) {
      headers.set(key, String(value));
    }
    for (const cookie of this.setCookieHeaders) {
      headers.append("set-cookie", cookie);
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
      cancel: (reason) => {
        this.bufferedChunks.length = 0;
        this.destroy(reason instanceof Error ? reason : new Error("Response body cancelled"));
      },
    });

    this.resolveResponse(new Response(stream, { status: this.resStatusCode, headers }));
  }
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
    options.request.headers,
    // Fetch runtimes do not expose a listening socket origin. Fall back to the
    // platform-provided Request URL origin and deliberately ignore any raw Host
    // header carried in request.headers.
    options.trustedRevalidateOrigin ?? new URL(options.request.url).origin,
    options.allowedRevalidateHeaderKeys,
  ) as PagesReqResResponse;
  attachPagesPreviewApi(req, res);

  return { req, res, responsePromise };
}
