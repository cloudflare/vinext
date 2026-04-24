import { decode as decodeQueryString } from "node:querystring";
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
};

export type PagesReqResHeaders = {
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

  const req: PagesReqResRequest = {
    method: options.request.method,
    url: options.url,
    headers: headersObj,
    query: options.query,
    body: options.body,
    cookies: parseCookies(options.request.headers.get("cookie")),
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
  };

  return { req, res, responsePromise };
}
