import { decode as decodeQueryString } from "node:querystring";
import { Readable, Writable } from "node:stream";
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

async function* requestBodyChunks(request: Request): AsyncGenerator<Uint8Array> {
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
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

function createRequestReadable(request: Request): Readable {
  return Readable.from(requestBodyChunks(request));
}

class PagesResponseStream extends Writable {
  private resStatusCode = 200;
  private readonly resHeaders: Record<string, string | number | boolean> = {};
  private readonly setCookieHeaders: string[] = [];
  private readonly chunks: Buffer[] = [];
  private resolved = false;

  constructor(
    private readonly resolveResponse: (value: Response) => void,
    private readonly requestHeaders: Headers,
  ) {
    super();
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
    return this;
  }

  setHeader(name: string, value: string | number | boolean | string[]): PagesReqResResponse {
    this.setHeaderValue(name, value, { replaceSetCookie: true });
    return this;
  }

  getHeader(name: string): string | number | boolean | string[] | undefined {
    if (name.toLowerCase() === "set-cookie") {
      return this.setCookieHeaders.length > 0 ? this.setCookieHeaders : undefined;
    }
    return this.resHeaders[name.toLowerCase()];
  }

  status(code: number): PagesReqResResponse {
    this.resStatusCode = code;
    return this;
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

  override _write(
    chunk: Uint8Array | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    try {
      this.chunks.push(
        typeof chunk === "string" ? Buffer.from(chunk, encoding) : Buffer.from(chunk),
      );
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.resolveOnce();
    callback();
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

    const body = this.chunks.length > 0 ? new Uint8Array(Buffer.concat(this.chunks)) : null;
    this.resolveResponse(new Response(body, { status: this.resStatusCode, headers }));
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
  const req: PagesReqResRequest = Object.assign(createRequestReadable(options.request), {
    method: options.request.method,
    url: options.url,
    headers: headersObj,
    query: options.query,
    body: options.body,
    cookies: parseCookies(options.request.headers.get("cookie")),
  });

  let resolveResponse!: (value: Response) => void;
  const responsePromise = new Promise<Response>((resolve) => {
    resolveResponse = resolve;
  });
  const res: PagesReqResResponse = new PagesResponseStream(
    resolveResponse,
    options.request.headers,
  );

  return { req, res, responsePromise };
}
