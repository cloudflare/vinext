/**
 * Tests for Pages Router `api.bodyParser` config support.
 *
 * Covers F-PROD-4: vinext previously ignored
 * `export const config = { api: { bodyParser: ... } }` and silently parsed
 * the body with a hard-coded 1 MB limit, breaking webhook handlers (Stripe,
 * GitHub, Slack) that need the raw stream for HMAC verification.
 *
 * Exercises both code paths:
 *   - Node/dev:  packages/vinext/src/server/api-handler.ts
 *   - Workers:   packages/vinext/src/server/pages-api-route.ts +
 *                packages/vinext/src/server/pages-node-compat.ts
 *
 * Next.js reference:
 *   packages/next/src/server/api-utils/node/api-resolver.ts (lines ~350-385)
 *   honours `config.api?.bodyParser !== false` and
 *   `config.api?.bodyParser?.sizeLimit`.
 */
import { PassThrough } from "node:stream";
import { Buffer } from "node:buffer";
import http from "node:http";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { handleApiRoute } from "../packages/vinext/src/server/api-handler.js";
import {
  handlePagesApiRoute,
  type PagesApiRouteMatch,
} from "../packages/vinext/src/server/pages-api-route.js";
import {
  parseSizeLimit,
  resolveBodyParserConfig,
} from "../packages/vinext/src/server/pages-body-parser-config.js";
import type { ModuleImporter } from "../packages/vinext/src/server/instrumentation.js";
import type { Route } from "../packages/vinext/src/routing/pages-router.js";

vi.mock("../packages/vinext/src/server/instrumentation.js", () => ({
  reportRequestError: vi.fn(() => Promise.resolve()),
  importModule: (runner: { import(id: string): Promise<unknown> }, id: string) =>
    runner.import(id) as Promise<Record<string, any>>,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

// ── parseSizeLimit ───────────────────────────────────────────────────────

describe("parseSizeLimit", () => {
  it("parses unit-suffixed strings (case-insensitive)", () => {
    expect(parseSizeLimit("1b")).toBe(1);
    expect(parseSizeLimit("100kb")).toBe(100 * 1024);
    expect(parseSizeLimit("4mb")).toBe(4 * 1024 * 1024);
    expect(parseSizeLimit("1gb")).toBe(1024 * 1024 * 1024);
    expect(parseSizeLimit("4MB")).toBe(4 * 1024 * 1024);
    expect(parseSizeLimit("  4mb  ")).toBe(4 * 1024 * 1024);
  });

  it("parses decimal numbers", () => {
    expect(parseSizeLimit("1.5mb")).toBe(Math.floor(1.5 * 1024 * 1024));
  });

  it("treats a bare number as bytes", () => {
    expect(parseSizeLimit("1024")).toBe(1024);
    expect(parseSizeLimit(1024)).toBe(1024);
  });

  it("returns undefined for unparseable input", () => {
    expect(parseSizeLimit("")).toBeUndefined();
    expect(parseSizeLimit("nope")).toBeUndefined();
    expect(parseSizeLimit("4xb")).toBeUndefined();
    expect(parseSizeLimit(undefined)).toBeUndefined();
    expect(parseSizeLimit(-1)).toBeUndefined();
    expect(parseSizeLimit(Number.NaN)).toBeUndefined();
  });
});

// ── resolveBodyParserConfig ──────────────────────────────────────────────

describe("resolveBodyParserConfig", () => {
  const DEFAULT = 1024 * 1024;

  it("defaults to enabled with 1 MB when config is missing", () => {
    expect(resolveBodyParserConfig(undefined)).toEqual({
      enabled: true,
      sizeLimit: DEFAULT,
    });
    expect(resolveBodyParserConfig({})).toEqual({
      enabled: true,
      sizeLimit: DEFAULT,
    });
    expect(resolveBodyParserConfig({ api: {} })).toEqual({
      enabled: true,
      sizeLimit: DEFAULT,
    });
  });

  it("treats `bodyParser: false` as disabled", () => {
    expect(resolveBodyParserConfig({ api: { bodyParser: false } })).toEqual({
      enabled: false,
    });
  });

  it("treats `bodyParser: true` as default-enabled", () => {
    expect(resolveBodyParserConfig({ api: { bodyParser: true } })).toEqual({
      enabled: true,
      sizeLimit: DEFAULT,
    });
  });

  it("honours `sizeLimit` from the object form", () => {
    expect(resolveBodyParserConfig({ api: { bodyParser: { sizeLimit: "4mb" } } })).toEqual({
      enabled: true,
      sizeLimit: 4 * 1024 * 1024,
    });
    expect(resolveBodyParserConfig({ api: { bodyParser: { sizeLimit: "100kb" } } })).toEqual({
      enabled: true,
      sizeLimit: 100 * 1024,
    });
    expect(resolveBodyParserConfig({ api: { bodyParser: { sizeLimit: 2048 } } })).toEqual({
      enabled: true,
      sizeLimit: 2048,
    });
  });

  it("falls back to default when sizeLimit is unparseable", () => {
    expect(
      resolveBodyParserConfig({
        api: { bodyParser: { sizeLimit: "bogus" as unknown as string } },
      }),
    ).toEqual({ enabled: true, sizeLimit: DEFAULT });
  });
});

// ── Helpers shared by the integration tests below ────────────────────────

function mockReq(
  method: string,
  url: string,
  body?: string | Buffer,
  headers: Record<string, string> = {},
): http.IncomingMessage {
  const stream = new PassThrough();
  const req = Object.assign(stream, {
    method,
    url,
    headers: { ...headers },
    httpVersion: "1.1",
    httpVersionMajor: 1,
    httpVersionMinor: 1,
    complete: false,
    connection: null,
    socket: null,
    aborted: false,
    rawHeaders: [] as string[],
    trailers: {} as Record<string, string | undefined>,
    rawTrailers: [] as string[],
    statusCode: undefined,
    statusMessage: undefined,
  }) as unknown as http.IncomingMessage;

  if (body !== undefined && body !== null) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf-8");
    queueMicrotask(() => {
      stream.push(buf);
      stream.push(null);
    });
  } else {
    queueMicrotask(() => stream.push(null));
  }

  return req;
}

function mockReqChunked(
  method: string,
  url: string,
  chunks: Buffer[],
  headers: Record<string, string> = {},
): http.IncomingMessage {
  const stream = new PassThrough();
  const req = Object.assign(stream, {
    method,
    url,
    headers: { ...headers },
    httpVersion: "1.1",
    httpVersionMajor: 1,
    httpVersionMinor: 1,
    complete: false,
    connection: null,
    socket: null,
    aborted: false,
    rawHeaders: [] as string[],
    trailers: {} as Record<string, string | undefined>,
    rawTrailers: [] as string[],
    statusCode: undefined,
    statusMessage: undefined,
  }) as unknown as http.IncomingMessage;

  queueMicrotask(() => {
    for (const c of chunks) {
      if (!stream.destroyed) stream.push(c);
    }
    if (!stream.destroyed) stream.push(null);
  });

  return req;
}

function mockRes(): http.ServerResponse & {
  _body: string | Buffer;
  _headers: Record<string, string | string[]>;
  _statusCode: number;
  _ended: boolean;
} {
  const headers: Record<string, string | string[]> = {};
  const res = {
    statusCode: 200,
    _body: "" as string | Buffer,
    _headers: headers,
    _statusCode: 200,
    _ended: false,
    setHeader(name: string, value: string | string[]) {
      headers[name.toLowerCase()] = value;
    },
    getHeader(name: string) {
      return headers[name.toLowerCase()];
    },
    writeHead(status: number, hdrs?: Record<string, string>) {
      res.statusCode = status;
      res._statusCode = status;
      if (hdrs) {
        for (const [k, v] of Object.entries(hdrs)) {
          headers[k.toLowerCase()] = v;
        }
      }
    },
    write(data: string | Buffer | Uint8Array) {
      const chunk =
        typeof data === "string"
          ? Buffer.from(data)
          : Buffer.isBuffer(data)
            ? data
            : Buffer.from(data);
      res._body = Buffer.isBuffer(res._body)
        ? Buffer.concat([res._body, chunk])
        : res._body
          ? Buffer.concat([Buffer.from(res._body), chunk])
          : chunk;
      return true;
    },
    end(data?: string | Buffer) {
      if (data !== undefined) {
        res._body = data;
      }
      res._ended = true;
      res._statusCode = res.statusCode;
    },
  } as unknown as http.ServerResponse & {
    _body: string | Buffer;
    _headers: Record<string, string | string[]>;
    _statusCode: number;
    _ended: boolean;
  };
  return res;
}

function route(pattern: string, filePath = "/fake/api/handler.ts"): Route {
  return {
    pattern,
    patternParts: pattern.split("/").filter(Boolean),
    filePath,
    isDynamic: false,
    params: [],
  };
}

function mockServer(moduleExport: Record<string, unknown>): ModuleImporter {
  return { import: vi.fn().mockResolvedValue(moduleExport) };
}

// ── Node/dev path: api-handler.ts ────────────────────────────────────────

describe("handleApiRoute body parser config (Node/dev path)", () => {
  it("bodyParser: false leaves req intact so handler can read the raw stream", async () => {
    let receivedBodyField: unknown = "sentinel";
    let receivedRaw = "";
    const handler = vi.fn(async (req: any) => {
      receivedBodyField = req.body;
      // Read directly from the underlying stream (the IncomingMessage).
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      receivedRaw = Buffer.concat(chunks).toString("utf-8");
    });
    const server = mockServer({
      default: handler,
      config: { api: { bodyParser: false } },
    });

    const payload = JSON.stringify({ webhook: "stripe", evt: "payment.succeeded" });
    const req = mockReq("POST", "/api/webhook", payload, {
      "content-type": "application/json",
      "stripe-signature": "v1=abc",
    });
    const res = mockRes();

    await handleApiRoute(server, req, res, "/api/webhook", [route("/api/webhook")]);

    expect(handler).toHaveBeenCalledOnce();
    // With bodyParser: false, req.body is undefined; raw bytes are intact.
    expect(receivedBodyField).toBeUndefined();
    expect(receivedRaw).toBe(payload);
  });

  it("bodyParser: { sizeLimit: '4mb' } accepts a 2 MB body that the default would reject", async () => {
    let capturedSize = 0;
    const handler = vi.fn((req: any) => {
      capturedSize = typeof req.body === "string" ? req.body.length : 0;
    });
    const server = mockServer({
      default: handler,
      config: { api: { bodyParser: { sizeLimit: "4mb" } } },
    });

    // 2 MB of plain text — would exceed the hard-coded 1 MB default.
    const twoMB = 2 * 1024 * 1024;
    const chunks = [Buffer.alloc(twoMB, 0x41)];
    const req = mockReqChunked("POST", "/api/upload", chunks, {
      "content-type": "text/plain",
    });
    const res = mockRes();

    await handleApiRoute(server, req, res, "/api/upload", [route("/api/upload")]);

    expect(handler).toHaveBeenCalledOnce();
    expect(res._statusCode).not.toBe(413);
    expect(capturedSize).toBe(twoMB);
  });

  it("bodyParser: { sizeLimit: '4mb' } rejects a 5 MB body with 413", async () => {
    const handler = vi.fn();
    const server = mockServer({
      default: handler,
      config: { api: { bodyParser: { sizeLimit: "4mb" } } },
    });

    // Push 5 chunks of 1 MB each — 5 MB total.
    const chunks = Array.from({ length: 5 }, () => Buffer.alloc(1024 * 1024, 0x41));
    const req = mockReqChunked("POST", "/api/upload", chunks, {
      "content-type": "text/plain",
    });
    const res = mockRes();

    await handleApiRoute(server, req, res, "/api/upload", [route("/api/upload")]);

    expect(handler).not.toHaveBeenCalled();
    expect(res._statusCode).toBe(413);
    expect(res._body).toBe("Request body too large");
  });

  it("bodyParser: { sizeLimit: '100kb' } rejects a 200 KB body with 413", async () => {
    const handler = vi.fn();
    const server = mockServer({
      default: handler,
      config: { api: { bodyParser: { sizeLimit: "100kb" } } },
    });

    const chunks = [Buffer.alloc(200 * 1024, 0x41)];
    const req = mockReqChunked("POST", "/api/upload", chunks, {
      "content-type": "text/plain",
    });
    const res = mockRes();

    await handleApiRoute(server, req, res, "/api/upload", [route("/api/upload")]);

    expect(handler).not.toHaveBeenCalled();
    expect(res._statusCode).toBe(413);
  });

  it("no config preserves the 1 MB default", async () => {
    const handler = vi.fn();
    const server = mockServer({ default: handler });

    const chunks = Array.from({ length: 5 }, () => Buffer.alloc(256 * 1024, 0x41));
    const req = mockReqChunked("POST", "/api/upload", chunks, {
      "content-type": "text/plain",
    });
    const res = mockRes();

    await handleApiRoute(server, req, res, "/api/upload", [route("/api/upload")]);

    expect(handler).not.toHaveBeenCalled();
    expect(res._statusCode).toBe(413);
  });

  it("bodyParser: true behaves like the default 1 MB limit", async () => {
    const handler = vi.fn();
    const server = mockServer({
      default: handler,
      config: { api: { bodyParser: true } },
    });

    const chunks = Array.from({ length: 5 }, () => Buffer.alloc(256 * 1024, 0x41));
    const req = mockReqChunked("POST", "/api/upload", chunks, {
      "content-type": "text/plain",
    });
    const res = mockRes();

    await handleApiRoute(server, req, res, "/api/upload", [route("/api/upload")]);

    expect(handler).not.toHaveBeenCalled();
    expect(res._statusCode).toBe(413);
  });
});

// ── Workers/prod path: pages-api-route.ts ────────────────────────────────

type PagesApiRouteModule = PagesApiRouteMatch["route"]["module"];

function createMatch(
  handler: PagesApiRouteModule["default"],
  moduleConfig?: PagesApiRouteModule["config"],
): PagesApiRouteMatch {
  return {
    params: {},
    route: {
      pattern: "/api/webhook",
      module: {
        config: moduleConfig,
        default: handler,
      },
    },
  };
}

describe("handlePagesApiRoute body parser config (Workers/prod path)", () => {
  it("bodyParser: false exposes the raw request body as a ReadableStream on req.body", async () => {
    let received: unknown = "sentinel";
    let receivedRaw = "";

    const response = await handlePagesApiRoute({
      match: createMatch(
        async (req: any, res: any) => {
          received = req.body;
          // Verify it's a ReadableStream and we can read it.
          if (req.body instanceof ReadableStream) {
            const reader = (req.body as ReadableStream<Uint8Array>).getReader();
            const chunks: Uint8Array[] = [];
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
              }
            } finally {
              reader.releaseLock();
            }
            const total = chunks.reduce((n, c) => n + c.byteLength, 0);
            const merged = new Uint8Array(total);
            let offset = 0;
            for (const c of chunks) {
              merged.set(c, offset);
              offset += c.byteLength;
            }
            receivedRaw = new TextDecoder().decode(merged);
          }
          res.json({ ok: true });
        },
        { api: { bodyParser: false } },
      ),
      request: new Request("https://example.com/api/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "stripe-signature": "v1=abc",
        },
        body: JSON.stringify({ webhook: "stripe", evt: "payment.succeeded" }),
      }),
      url: "/api/webhook",
    });

    expect(response.status).toBe(200);
    expect(received).toBeInstanceOf(ReadableStream);
    expect(receivedRaw).toBe(JSON.stringify({ webhook: "stripe", evt: "payment.succeeded" }));
  });

  it("bodyParser: { sizeLimit: '4mb' } accepts a 2 MB body that the default would reject", async () => {
    const payload = "A".repeat(2 * 1024 * 1024);
    const response = await handlePagesApiRoute({
      match: createMatch(
        (req: any, res: any) => {
          const size = typeof req.body === "string" ? req.body.length : 0;
          res.json({ size });
        },
        { api: { bodyParser: { sizeLimit: "4mb" } } },
      ),
      request: new Request("https://example.com/api/upload", {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          "content-length": String(payload.length),
        },
        body: payload,
      }),
      url: "/api/upload",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ size: 2 * 1024 * 1024 });
  });

  it("bodyParser: { sizeLimit: '4mb' } rejects a 5 MB body with 413", async () => {
    const payload = "A".repeat(5 * 1024 * 1024);
    const response = await handlePagesApiRoute({
      match: createMatch(
        (_req: any, res: any) => {
          res.json({ ok: true });
        },
        { api: { bodyParser: { sizeLimit: "4mb" } } },
      ),
      request: new Request("https://example.com/api/upload", {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          "content-length": String(payload.length),
        },
        body: payload,
      }),
      url: "/api/upload",
    });

    expect(response.status).toBe(413);
  });

  it("bodyParser: { sizeLimit: '100kb' } rejects a 200 KB body with 413", async () => {
    const payload = "A".repeat(200 * 1024);
    const response = await handlePagesApiRoute({
      match: createMatch(
        (_req: any, res: any) => {
          res.json({ ok: true });
        },
        { api: { bodyParser: { sizeLimit: "100kb" } } },
      ),
      request: new Request("https://example.com/api/upload", {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          "content-length": String(payload.length),
        },
        body: payload,
      }),
      url: "/api/upload",
    });

    expect(response.status).toBe(413);
  });

  it("no config preserves the 1 MB default", async () => {
    const payload = "A".repeat(2 * 1024 * 1024);
    const response = await handlePagesApiRoute({
      match: createMatch((_req: any, res: any) => {
        res.json({ ok: true });
      }),
      request: new Request("https://example.com/api/upload", {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          "content-length": String(payload.length),
        },
        body: payload,
      }),
      url: "/api/upload",
    });

    expect(response.status).toBe(413);
  });

  it("bodyParser: true behaves like the default 1 MB limit", async () => {
    const payload = "A".repeat(2 * 1024 * 1024);
    const response = await handlePagesApiRoute({
      match: createMatch(
        (_req: any, res: any) => {
          res.json({ ok: true });
        },
        { api: { bodyParser: true } },
      ),
      request: new Request("https://example.com/api/upload", {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          "content-length": String(payload.length),
        },
        body: payload,
      }),
      url: "/api/upload",
    });

    expect(response.status).toBe(413);
  });
});
