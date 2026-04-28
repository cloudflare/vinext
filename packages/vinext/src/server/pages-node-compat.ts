import { decode as decodeQueryString } from "node:querystring";
import { Readable, Writable } from "node:stream";
import { parseCookies } from "../config/config-matchers.js";
import { PagesBodyParseError, getMediaType, isJsonMediaType } from "./pages-media-type.js";

const MAX_PAGES_API_BODY_SIZE = 1 * 1024 * 1024;

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
  [Symbol.asyncIterator]: () => AsyncIterableIterator<Buffer>;
} & Readable;

export type PagesReqResHeaders = {
  [key: string]: string | number | boolean | string[];
};

export type PagesReqResResponse = {
  statusCode: number;
  readonly headersSent: boolean;
  writeHead: (code: number, headers?: PagesReqResHeaders) => PagesReqResResponse;
  setHeader: (name: string, value: string | number | boolean | string[]) => PagesReqResResponse;
  getHeader: (name: string) => string | number | boolean | string[] | undefined;
  write: (chunk: string | Uint8Array | Buffer) => boolean;
  end: (data?: BodyInit | null) => void;
  status: (code: number) => PagesReqResResponse;
  json: (data: unknown) => void;
  send: (data: unknown) => void;
  redirect: (statusOrUrl: number | string, url?: string) => void;
  setPreviewData: (data: unknown) => PagesReqResResponse;
  clearPreviewData: () => PagesReqResResponse;
  revalidate: (urlPath: string, options?: { unstable_onlyGenerated?: boolean }) => Promise<void>;
  getHeaders: () => PagesReqResHeaders;
} & Writable;

type CreatePagesReqResOptions = {
  body: unknown;
  onRevalidate?: (
    urlPath: string,
    options?: { unstable_onlyGenerated?: boolean },
  ) => Promise<void> | void;
  preserveRequestBodyStream?: boolean;
  query: PagesRequestQuery;
  request: Request;
  url: string;
};

type CreatePagesReqResResult = {
  isResponsePiped: () => boolean;
  req: PagesReqResRequest;
  res: PagesReqResResponse;
  responsePromise: Promise<Response>;
};

async function readPagesRequestBodyWithLimit(request: Request, maxBytes: number): Promise<string> {
  if (!request.body) {
    return "";
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let totalSize = 0;

  for (;;) {
    const result = await reader.read();
    if (result.done) {
      break;
    }

    totalSize += result.value.byteLength;
    if (totalSize > maxBytes) {
      await reader.cancel();
      throw new PagesBodyParseError("Request body too large", 413);
    }

    chunks.push(decoder.decode(result.value, { stream: true }));
  }

  chunks.push(decoder.decode());
  return chunks.join("");
}

export function parsePagesBodySizeLimit(
  sizeLimit: number | string | undefined,
  fallback = MAX_PAGES_API_BODY_SIZE,
): number {
  if (typeof sizeLimit === "number" && Number.isFinite(sizeLimit) && sizeLimit >= 0) {
    return sizeLimit;
  }

  if (typeof sizeLimit !== "string") {
    return fallback;
  }

  const match = sizeLimit
    .trim()
    .toLowerCase()
    .match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/);
  if (!match) {
    return fallback;
  }

  const value = Number.parseFloat(match[1]);
  const unit = match[2] ?? "b";
  const multiplier =
    unit === "gb" ? 1024 * 1024 * 1024 : unit === "mb" ? 1024 * 1024 : unit === "kb" ? 1024 : 1;

  return Math.floor(value * multiplier);
}

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

  const reqStream =
    options.preserveRequestBodyStream && options.request.body
      ? Readable.fromWeb(
          options.request.body as import("node:stream/web").ReadableStream<Uint8Array>,
        )
      : Readable.from([]);
  const req = reqStream as PagesReqResRequest;
  req.method = options.request.method;
  req.url = options.url;
  req.headers = headersObj;
  req.query = options.query;
  req.body = options.body;
  req.cookies = parseCookies(options.request.headers.get("cookie"));

  let resStatusCode = 200;
  const resHeaders: Record<string, string | number | boolean> = {};
  const setCookieHeaders: string[] = [];
  const resBodyChunks: Buffer[] = [];
  let responsePiped = false;
  let ended = false;
  let resolveResponse!: (value: Response) => void;
  const responsePromise = new Promise<Response>((resolve) => {
    resolveResponse = resolve;
  });

  function normalizeResponseChunk(data: BodyInit): Buffer {
    if (Buffer.isBuffer(data)) return data;
    if (data instanceof Uint8Array) return Buffer.from(data);
    if (data instanceof ArrayBuffer) return Buffer.from(data);
    return Buffer.from(String(data));
  }

  function resolveOnce(): void {
    if (ended) {
      return;
    }
    ended = true;
    const headers = new Headers();
    for (const [key, value] of Object.entries(resHeaders)) {
      headers.set(key, String(value));
    }
    for (const cookie of setCookieHeaders) {
      headers.append("set-cookie", cookie);
    }
    const body = resBodyChunks.length > 0 ? Buffer.concat(resBodyChunks) : null;
    resolveResponse(new Response(body, { status: resStatusCode, headers }));
  }

  const resStream = new Writable({
    write(chunk, _encoding, callback) {
      if (chunk !== undefined && chunk !== null) {
        resBodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      callback();
    },
  });
  resStream.on("pipe", () => {
    responsePiped = true;
  });
  resStream.on("finish", resolveOnce);

  const streamWrite = resStream.write.bind(resStream);
  const streamEnd = resStream.end.bind(resStream);
  const res = resStream as PagesReqResResponse;

  Object.defineProperties(res, {
    statusCode: {
      get() {
        return resStatusCode;
      },
      set(code: number) {
        resStatusCode = code;
      },
    },
    headersSent: {
      get() {
        return ended || res.writableEnded;
      },
    },
  });

  Object.assign(res, {
    writeHead(code: number, headers?: PagesReqResHeaders) {
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
    write(chunk: string | Uint8Array | Buffer) {
      return streamWrite(chunk);
    },
    setHeader(name: string, value: string | number | boolean | string[]) {
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
    getHeader(name: string) {
      if (name.toLowerCase() === "set-cookie") {
        return setCookieHeaders.length > 0 ? setCookieHeaders : undefined;
      }
      return resHeaders[name.toLowerCase()];
    },
    end(data?: BodyInit | null) {
      if (ended || res.writableEnded) {
        return;
      }
      if (data !== undefined && data !== null) {
        resBodyChunks.push(normalizeResponseChunk(data));
      }
      streamEnd();
      resolveOnce();
    },
    status(code: number) {
      resStatusCode = code;
      return res;
    },
    json(data: unknown) {
      resHeaders["content-type"] = "application/json";
      res.end(JSON.stringify(data));
    },
    send(data: unknown) {
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
    redirect(statusOrUrl: number | string, url?: string) {
      if (typeof statusOrUrl === "string") {
        res.writeHead(307, { Location: statusOrUrl });
      } else {
        res.writeHead(statusOrUrl, { Location: url ?? "" });
      }
      res.end();
    },
    setPreviewData(data: unknown) {
      const encoded = Buffer.from(JSON.stringify(data)).toString("base64url");
      setCookieHeaders.push(`__prerender_bypass=vinext-preview; Path=/; SameSite=Lax`);
      setCookieHeaders.push(`__next_preview_data=${encoded}; Path=/; SameSite=Lax; HttpOnly`);
      return res;
    },
    clearPreviewData() {
      setCookieHeaders.push(`__prerender_bypass=; Path=/; Max-Age=0; SameSite=Lax`);
      setCookieHeaders.push(`__next_preview_data=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly`);
      return res;
    },
    async revalidate(urlPath: string, revalidateOptions?: { unstable_onlyGenerated?: boolean }) {
      await options.onRevalidate?.(urlPath, revalidateOptions);
    },
    getHeaders() {
      const headers: PagesReqResHeaders = { ...resHeaders };
      if (setCookieHeaders.length > 0) {
        headers["set-cookie"] = setCookieHeaders;
      }
      return headers;
    },
  });

  return { isResponsePiped: () => responsePiped, req, res, responsePromise };
}
