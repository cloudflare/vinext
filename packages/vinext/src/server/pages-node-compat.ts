import { decode as decodeQueryString } from "node:querystring";
import { Readable, Writable } from "node:stream";
import { parseCookieHeader } from "../utils/parse-cookie.js";
import { readStreamAsTextWithLimit } from "../utils/text-stream.js";
import { DEFAULT_PAGES_API_BODY_SIZE_LIMIT } from "./pages-body-parser-config.js";
import { PagesBodyParseError, getMediaType, isJsonMediaType } from "./pages-media-type.js";
import { performOnDemandRevalidate, type RevalidateOptions } from "./pages-revalidate.js";
import { getRevalidateSecret, isRevalidateSecret } from "./isr-cache.js";

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
  redirect: (statusOrUrl: number | string, url?: string) => void;
  getHeaders: () => PagesReqResHeaders;
  revalidate: (urlPath: string, opts?: RevalidateOptions) => Promise<void>;
  setPreviewData: (
    data: object | string,
    options?: { maxAge?: number; path?: string },
  ) => PagesReqResResponse;
};

type PagesRequestCookiesCarrier = {
  headers: {
    cookie?: string | string[] | null | undefined;
  };
  cookies?: unknown;
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

export type PagesPreviewData = object | string;

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

function serializePreviewCookie(
  name: "__prerender_bypass" | "__next_preview_data",
  value: string,
  options: { maxAge?: number; path?: string } = {},
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "HttpOnly",
    `Path=${options.path ?? "/"}`,
    process.env.NODE_ENV !== "development" ? "SameSite=None" : "SameSite=Lax",
  ];
  if (process.env.NODE_ENV !== "development") {
    parts.push("Secure");
  }
  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${Math.trunc(options.maxAge)}`);
  }
  return parts.join("; ");
}

function decodePagesPreviewPayload(payload: string): PagesPreviewData | false {
  try {
    const decoded = Buffer.from(payload, "base64url").toString("utf8");
    const value = JSON.parse(decoded);
    return typeof value === "object" && value !== null ? value : String(value);
  } catch {
    return false;
  }
}

export function getPagesPreviewDataFromCookieHeader(
  cookieHeader: string | string[] | null | undefined,
  options: { isOnDemandRevalidate?: boolean } = {},
): PagesPreviewData | false {
  // Next.js disables preview mode during on-demand revalidation so preview
  // cookies cannot poison the regenerated ISR entry.
  if (options.isOnDemandRevalidate) return false;

  const cookies = parsePagesRequestCookies(cookieHeader);
  const bypass = cookies.__prerender_bypass;
  const payload = cookies.__next_preview_data;
  if (!bypass && !payload) return false;
  if (!isRevalidateSecret(bypass)) return false;
  if (!payload) return {};

  // vinext writes preview data as base64url(JSON) instead of Next.js's signed
  // encrypted JWT. The writer and reader are intentionally paired internally.
  return decodePagesPreviewPayload(payload);
}

export function getPagesPreviewData(
  request: Request,
  options: { isOnDemandRevalidate?: boolean } = {},
): PagesPreviewData | false {
  return getPagesPreviewDataFromCookieHeader(request.headers.get("cookie"), options);
}

function normalizeSetCookieHeader(
  value: string | number | boolean | string[] | undefined,
): string[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value.map(String);
  return [String(value)];
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
        this.setHeaderValue(key, value, { replaceSetCookie: false });
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

  redirect(statusOrUrl: number | string, url?: string): void {
    if (typeof statusOrUrl === "string") {
      this.writeHead(307, { Location: statusOrUrl });
    } else {
      this.writeHead(statusOrUrl, { Location: url ?? "" });
    }
    this.end();
  }

  getHeaders(): PagesReqResHeaders {
    const headers: PagesReqResHeaders = { ...this.resHeaders };
    if (this.setCookieHeaders.length > 0) {
      headers["set-cookie"] = this.setCookieHeaders;
    }
    return headers;
  }

  async revalidate(urlPath: string, opts?: RevalidateOptions): Promise<void> {
    await performOnDemandRevalidate(this.requestHeaders, urlPath, opts);
  }

  setPreviewData(
    data: object | string,
    options: { maxAge?: number; path?: string } = {},
  ): PagesReqResResponse {
    const payload = Buffer.from(JSON.stringify(data)).toString("base64url");
    if (payload.length > 2048) {
      throw new Error(
        "Preview data is limited to 2KB currently, reduce how much data you are storing as preview data to continue",
      );
    }

    this.setHeader("Set-Cookie", [
      ...normalizeSetCookieHeader(this.getHeader("Set-Cookie")),
      serializePreviewCookie("__prerender_bypass", getRevalidateSecret(), options),
      serializePreviewCookie("__next_preview_data", payload, options),
    ]);
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
      if (options.replaceSetCookie) {
        this.setCookieHeaders.length = 0;
      }
      if (Array.isArray(value)) {
        this.setCookieHeaders.push(...value.map(String));
      } else {
        this.setCookieHeaders.push(String(value));
      }
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
  ) as PagesReqResResponse;

  return { req, res, responsePromise };
}
