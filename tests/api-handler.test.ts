/**
 * Unit tests for the Pages Router API route handler.
 *
 * Tests body parsing (JSON, form-urlencoded, plain text, empty),
 * cookie parsing, req/res Next.js extensions (status, json, send, redirect),
 * MAX_BODY_SIZE enforcement, missing default export handling, and
 * query string + dynamic param merging.
 *
 * Since parseBody, parseCookies, and enhanceApiObjects are not exported,
 * all behavior is tested indirectly through handleApiRoute with a mocked
 * ViteDevServer.
 */
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { AsyncLocalStorage } from "node:async_hooks";
import { PassThrough } from "node:stream";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { handleApiRoute } from "../packages/vinext/src/server/api-handler.js";
import {
  reportRequestError,
  type ModuleImporter,
} from "../packages/vinext/src/server/instrumentation.js";
import type { Route } from "../packages/vinext/src/routing/pages-router.js";

vi.mock("../packages/vinext/src/server/instrumentation.js", () => ({
  reportRequestError: vi.fn(() => Promise.resolve()),
  importModule: (runner: { import(id: string): Promise<unknown> }, id: string) =>
    runner.import(id) as Promise<Record<string, any>>,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Create a mock IncomingMessage from raw body bytes and headers.
 */
function mockReq(
  method: string,
  url: string,
  body?: string | Buffer,
  headers: Record<string, string> = {},
): http.IncomingMessage {
  const stream = new PassThrough();
  // Attach IncomingMessage-like properties
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

  // Push body data asynchronously so listeners have time to attach
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

/**
 * Create a mock ServerResponse that captures status, headers, and body.
 */
function mockRes(): http.ServerResponse & {
  _body: string | Buffer;
  _headers: Record<string, string | string[]>;
  _statusCode: number;
  _ended: boolean;
  _writes: Buffer[];
} {
  const headers: Record<string, string | string[]> = {};
  const res = {
    statusCode: 200,
    _body: "",
    _headers: headers,
    _statusCode: 200,
    _ended: false,
    _writes: [] as Buffer[],
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
      res._writes.push(chunk);
      res._body = Buffer.isBuffer(res._body)
        ? Buffer.concat([res._body, chunk])
        : res._body
          ? Buffer.concat([Buffer.from(res._body), chunk])
          : chunk;
      return true;
    },
    end(data?: string | Buffer) {
      if (data !== undefined) {
        if (res._writes.length) {
          res.write(data);
        } else {
          res._body = data;
        }
      }
      res._ended = true;
      res._statusCode = res.statusCode;
    },
  } as unknown as http.ServerResponse & {
    _body: string | Buffer;
    _headers: Record<string, string | string[]>;
    _statusCode: number;
    _ended: boolean;
    _writes: Buffer[];
  };
  return res;
}

/**
 * Build a Route matching any URL at the given pattern.
 */
function route(pattern: string, filePath = "/fake/api/handler.ts"): Route {
  const isDynamic = pattern.includes(":");
  const params = isDynamic ? [...pattern.matchAll(/:(\w+)/g)].map((m) => m[1]) : [];
  return { pattern, patternParts: pattern.split("/").filter(Boolean), filePath, isDynamic, params };
}

/**
 * Build a minimal mock ModuleImporter with configurable import behavior.
 */
function mockServer(moduleExport: Record<string, unknown>): ModuleImporter {
  return {
    import: vi.fn().mockResolvedValue(moduleExport),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("handleApiRoute", () => {
  // ── Route matching ──────────────────────────────────────────────────

  describe("route matching", () => {
    it("returns false when no route matches", async () => {
      const handler = vi.fn();
      const server = mockServer({ default: handler });
      const req = mockReq("GET", "/api/nonexistent");
      const res = mockRes();

      const handled = await handleApiRoute(server, req, res, "/api/nonexistent", [
        route("/api/users"),
      ]);

      expect(handled).toBe(false);
      expect(handler).not.toHaveBeenCalled();
    });

    it("returns true when a route matches", async () => {
      const handler = vi.fn();
      const server = mockServer({ default: handler });
      const req = mockReq("GET", "/api/users");
      const res = mockRes();

      const handled = await handleApiRoute(server, req, res, "/api/users", [route("/api/users")]);

      expect(handled).toBe(true);
      expect(handler).toHaveBeenCalledOnce();
    });
  });

  // ── Body parsing ───────────────────────────────────────────────────

  describe("body parsing", () => {
    it("parses JSON body with application/json content-type", async () => {
      let capturedBody: unknown;
      const handler = vi.fn((req: any) => {
        capturedBody = req.body;
      });
      const server = mockServer({ default: handler });
      const payload = JSON.stringify({ name: "Alice", age: 30 });
      const req = mockReq("POST", "/api/users", payload, {
        "content-type": "application/json",
      });
      const res = mockRes();

      await handleApiRoute(server, req, res, "/api/users", [route("/api/users")]);

      expect(capturedBody).toEqual({ name: "Alice", age: 30 });
    });

    // Ported from Next.js: test/integration/api-support/test/index.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/integration/api-support/test/index.test.ts
    it("returns 400 for malformed JSON instead of calling the handler", async () => {
      const handler = vi.fn();
      const server = mockServer({ default: handler });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const req = mockReq("POST", "/api/users", "{not json", {
        "content-type": "application/json",
      });
      const res = mockRes();

      await handleApiRoute(server, req, res, "/api/users", [route("/api/users")]);

      expect(handler).not.toHaveBeenCalled();
      expect(res._statusCode).toBe(400);
      expect(res.statusMessage).toBe("Invalid JSON");
      expect(res._body).toBe("Invalid JSON");
      expect(errorSpy).not.toHaveBeenCalled();
      expect(reportRequestError).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    it("parses empty application/json bodies as an empty object", async () => {
      let capturedBody: unknown;
      const handler = vi.fn((req: any) => {
        capturedBody = req.body;
      });
      const server = mockServer({ default: handler });
      const req = mockReq("POST", "/api/users", "", {
        "content-type": "application/json",
      });
      const res = mockRes();

      await handleApiRoute(server, req, res, "/api/users", [route("/api/users")]);

      expect(capturedBody).toEqual({});
    });

    it("parses application/x-www-form-urlencoded body", async () => {
      let capturedBody: unknown;
      const handler = vi.fn((req: any) => {
        capturedBody = req.body;
      });
      const server = mockServer({ default: handler });
      const req = mockReq("POST", "/api/users", "name=Alice&role=admin", {
        "content-type": "application/x-www-form-urlencoded",
      });
      const res = mockRes();

      await handleApiRoute(server, req, res, "/api/users", [route("/api/users")]);

      expect(capturedBody).toEqual({ name: "Alice", role: "admin" });
    });

    it("preserves duplicate application/x-www-form-urlencoded keys as arrays", async () => {
      let capturedBody: unknown;
      const handler = vi.fn((req: any) => {
        capturedBody = req.body;
      });
      const server = mockServer({ default: handler });
      const req = mockReq("POST", "/api/users", "tag=a&tag=b&tag=c", {
        "content-type": "application/x-www-form-urlencoded",
      });
      const res = mockRes();

      await handleApiRoute(server, req, res, "/api/users", [route("/api/users")]);

      expect(capturedBody).toEqual({ tag: ["a", "b", "c"] });
    });

    it("parses empty application/x-www-form-urlencoded bodies as an empty object", async () => {
      let capturedBody: unknown;
      const handler = vi.fn((req: any) => {
        capturedBody = req.body;
      });
      const server = mockServer({ default: handler });
      const req = mockReq("POST", "/api/users", "", {
        "content-type": "application/x-www-form-urlencoded",
      });
      const res = mockRes();

      await handleApiRoute(server, req, res, "/api/users", [route("/api/users")]);

      expect(capturedBody).toEqual({});
    });

    it("parses application/ld+json bodies as JSON", async () => {
      let capturedBody: unknown;
      const handler = vi.fn((req: any) => {
        capturedBody = req.body;
      });
      const server = mockServer({ default: handler });
      const req = mockReq("POST", "/api/users", JSON.stringify({ title: "doc" }), {
        "content-type": "application/ld+json; charset=utf-8",
      });
      const res = mockRes();

      await handleApiRoute(server, req, res, "/api/users", [route("/api/users")]);

      expect(capturedBody).toEqual({ title: "doc" });
    });

    it("returns raw string for unknown content-type", async () => {
      let capturedBody: unknown;
      const handler = vi.fn((req: any) => {
        capturedBody = req.body;
      });
      const server = mockServer({ default: handler });
      const req = mockReq("POST", "/api/users", "plain text body", {
        "content-type": "text/plain",
      });
      const res = mockRes();

      await handleApiRoute(server, req, res, "/api/users", [route("/api/users")]);

      expect(capturedBody).toBe("plain text body");
    });

    it("returns undefined for empty body", async () => {
      let capturedBody: unknown = "sentinel";
      const handler = vi.fn((req: any) => {
        capturedBody = req.body;
      });
      const server = mockServer({ default: handler });
      const req = mockReq("GET", "/api/users");
      const res = mockRes();

      await handleApiRoute(server, req, res, "/api/users", [route("/api/users")]);

      expect(capturedBody).toBeUndefined();
    });

    it("returns raw string when no content-type header is set", async () => {
      let capturedBody: unknown;
      const handler = vi.fn((req: any) => {
        capturedBody = req.body;
      });
      const server = mockServer({ default: handler });
      const req = mockReq("POST", "/api/users", "some data");
      const res = mockRes();

      await handleApiRoute(server, req, res, "/api/users", [route("/api/users")]);

      expect(capturedBody).toBe("some data");
    });
  });

  // ── MAX_BODY_SIZE enforcement ──────────────────────────────────────

  describe("MAX_BODY_SIZE enforcement", () => {
    it("rejects bodies exceeding 1 MB with 413 status", async () => {
      const handler = vi.fn();
      const server = mockServer({ default: handler });

      // Create a stream that pushes > 1 MB.
      // Do NOT override destroy — let PassThrough's native destroy work
      // so req.destroy() in parseBody doesn't recurse.
      const stream = new PassThrough();
      const req = Object.assign(stream, {
        method: "POST",
        url: "/api/upload",
        headers: { "content-type": "text/plain" } as Record<string, string>,
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

      const res = mockRes();

      // Push data in chunks that exceed MAX_BODY_SIZE (1 MB)
      const chunkSize = 256 * 1024; // 256 KB
      const totalChunks = 5; // 1.25 MB total
      queueMicrotask(() => {
        for (let i = 0; i < totalChunks; i++) {
          if (!stream.destroyed) {
            stream.push(Buffer.alloc(chunkSize, 0x41));
          }
        }
        if (!stream.destroyed) {
          stream.push(null);
        }
      });

      await handleApiRoute(server, req, res, "/api/upload", [route("/api/upload")]);

      expect(handler).not.toHaveBeenCalled();
      expect(res._statusCode).toBe(413);
      expect(res._body).toBe("Request body too large");
    });

    it("accepts bodies within 1 MB limit", async () => {
      let capturedBody: unknown;
      const handler = vi.fn((req: any) => {
        capturedBody = req.body;
      });
      const server = mockServer({ default: handler });

      // Send exactly 512 KB — well within the 1 MB limit
      const body = "x".repeat(512 * 1024);
      const req = mockReq("POST", "/api/upload", body, {
        "content-type": "text/plain",
      });
      const res = mockRes();

      await handleApiRoute(server, req, res, "/api/upload", [route("/api/upload")]);

      expect(handler).toHaveBeenCalledOnce();
      expect(capturedBody).toBe(body);
    });
  });

  // ── Cookie parsing ─────────────────────────────────────────────────

  describe("cookie parsing", () => {
    it("parses single cookie", async () => {
      let capturedCookies: Record<string, string> = {};
      const handler = vi.fn((req: any) => {
        capturedCookies = req.cookies;
      });
      const server = mockServer({ default: handler });
      const req = mockReq("GET", "/api/users", undefined, {
        cookie: "session=abc123",
      });
      const res = mockRes();

      await handleApiRoute(server, req, res, "/api/users", [route("/api/users")]);

      expect(capturedCookies).toEqual({ session: "abc123" });
    });

    it("parses multiple cookies", async () => {
      let capturedCookies: Record<string, string> = {};
      const handler = vi.fn((req: any) => {
        capturedCookies = req.cookies;
      });
      const server = mockServer({ default: handler });
      const req = mockReq("GET", "/api/users", undefined, {
        cookie: "session=abc123; theme=dark; lang=en",
      });
      const res = mockRes();

      await handleApiRoute(server, req, res, "/api/users", [route("/api/users")]);

      expect(capturedCookies).toEqual({
        session: "abc123",
        theme: "dark",
        lang: "en",
      });
    });

    it("handles cookies with = in the value", async () => {
      let capturedCookies: Record<string, string> = {};
      const handler = vi.fn((req: any) => {
        capturedCookies = req.cookies;
      });
      const server = mockServer({ default: handler });
      const req = mockReq("GET", "/api/users", undefined, {
        cookie: "token=abc=def=ghi",
      });
      const res = mockRes();

      await handleApiRoute(server, req, res, "/api/users", [route("/api/users")]);

      expect(capturedCookies).toEqual({ token: "abc=def=ghi" });
    });

    it("returns empty object when no Cookie header", async () => {
      let capturedCookies: Record<string, string> = {};
      const handler = vi.fn((req: any) => {
        capturedCookies = req.cookies;
      });
      const server = mockServer({ default: handler });
      const req = mockReq("GET", "/api/users");
      const res = mockRes();

      await handleApiRoute(server, req, res, "/api/users", [route("/api/users")]);

      expect(capturedCookies).toEqual({});
    });
  });

  // ── req/res extensions ─────────────────────────────────────────────

  describe("res.status()", () => {
    it("sets the status code and returns res for chaining", async () => {
      const handler = vi.fn((_req: any, res: any) => {
        const returned = res.status(201);
        // Should return res for chaining
        returned.json({ ok: true });
      });
      const server = mockServer({ default: handler });
      const req = mockReq("POST", "/api/users");
      const res = mockRes();

      await handleApiRoute(server, req, res, "/api/users", [route("/api/users")]);

      expect(res._statusCode).toBe(201);
      expect(res._headers["content-type"]).toBe("application/json");
      expect(JSON.parse(res._body as string)).toEqual({ ok: true });
    });
  });

  describe("res.json()", () => {
    it("sends JSON response with correct content-type", async () => {
      const handler = vi.fn((_req: any, res: any) => {
        res.json({ message: "hello" });
      });
      const server = mockServer({ default: handler });
      const req = mockReq("GET", "/api/users");
      const res = mockRes();

      await handleApiRoute(server, req, res, "/api/users", [route("/api/users")]);

      expect(res._headers["content-type"]).toBe("application/json");
      expect(JSON.parse(res._body as string)).toEqual({ message: "hello" });
    });

    it("serializes nested objects", async () => {
      const data = { users: [{ id: 1, name: "Alice" }], total: 1 };
      const handler = vi.fn((_req: any, res: any) => {
        res.json(data);
      });
      const server = mockServer({ default: handler });
      const req = mockReq("GET", "/api/users");
      const res = mockRes();

      await handleApiRoute(server, req, res, "/api/users", [route("/api/users")]);

      expect(JSON.parse(res._body as string)).toEqual(data);
    });
  });

  describe("res.send()", () => {
    it("sends object data as JSON", async () => {
      const handler = vi.fn((_req: any, res: any) => {
        res.send({ key: "value" });
      });
      const server = mockServer({ default: handler });
      const req = mockReq("GET", "/api/users");
      const res = mockRes();

      await handleApiRoute(server, req, res, "/api/users", [route("/api/users")]);

      expect(res._headers["content-type"]).toBe("application/json");
      expect(JSON.parse(res._body as string)).toEqual({ key: "value" });
    });

    it("sends string data as text/plain", async () => {
      const handler = vi.fn((_req: any, res: any) => {
        res.send("hello world");
      });
      const server = mockServer({ default: handler });
      const req = mockReq("GET", "/api/users");
      const res = mockRes();

      await handleApiRoute(server, req, res, "/api/users", [route("/api/users")]);

      expect(res._headers["content-type"]).toBe("text/plain");
      expect(res._body).toBe("hello world");
    });

    it("sends Buffer data as application/octet-stream bytes", async () => {
      const handler = vi.fn((_req: any, res: any) => {
        res.send(Buffer.from([1, 2, 3]));
      });
      const server = mockServer({ default: handler });
      const req = mockReq("GET", "/api/users");
      const res = mockRes();

      await handleApiRoute(server, req, res, "/api/users", [route("/api/users")]);

      expect(res._headers["content-type"]).toBe("application/octet-stream");
      expect(res._headers["content-length"]).toBe("3");
      expect(Buffer.isBuffer(res._body)).toBe(true);
      expect((res._body as Buffer).equals(Buffer.from([1, 2, 3]))).toBe(true);
    });

    it("sends number data as text/plain string", async () => {
      const handler = vi.fn((_req: any, res: any) => {
        res.send(42);
      });
      const server = mockServer({ default: handler });
      const req = mockReq("GET", "/api/users");
      const res = mockRes();

      await handleApiRoute(server, req, res, "/api/users", [route("/api/users")]);

      expect(res._headers["content-type"]).toBe("text/plain");
      expect(res._body).toBe("42");
    });

    it("preserves existing content-type for non-object data", async () => {
      const handler = vi.fn((_req: any, res: any) => {
        res.setHeader("Content-Type", "text/html");
        res.send("<h1>Hello</h1>");
      });
      const server = mockServer({ default: handler });
      const req = mockReq("GET", "/api/page");
      const res = mockRes();

      await handleApiRoute(server, req, res, "/api/page", [route("/api/page")]);

      expect(res._headers["content-type"]).toBe("text/html");
      expect(res._body).toBe("<h1>Hello</h1>");
    });

    it("sends null as text/plain, not JSON (typeof null is object but excluded)", async () => {
      // null is typeof 'object' but the code checks `data !== null`
      // so null falls through to text/plain
      const handler = vi.fn((_req: any, res: any) => {
        res.send(null);
      });
      const server = mockServer({ default: handler });
      const req = mockReq("GET", "/api/users");
      const res = mockRes();

      await handleApiRoute(server, req, res, "/api/users", [route("/api/users")]);

      expect(res._headers["content-type"]).toBe("text/plain");
      expect(res._body).toBe("null");
    });
  });

  describe("res.redirect()", () => {
    it("redirects with default 307 when given only a URL", async () => {
      const handler = vi.fn((_req: any, res: any) => {
        res.redirect("/dashboard");
      });
      const server = mockServer({ default: handler });
      const req = mockReq("GET", "/api/login");
      const res = mockRes();

      await handleApiRoute(server, req, res, "/api/login", [route("/api/login")]);

      expect(res._statusCode).toBe(307);
      expect(res._headers["location"]).toBe("/dashboard");
      expect(res._ended).toBe(true);
    });

    it("redirects with custom status code", async () => {
      const handler = vi.fn((_req: any, res: any) => {
        res.redirect(301, "/new-location");
      });
      const server = mockServer({ default: handler });
      const req = mockReq("GET", "/api/old");
      const res = mockRes();

      await handleApiRoute(server, req, res, "/api/old", [route("/api/old")]);

      expect(res._statusCode).toBe(301);
      expect(res._headers["location"]).toBe("/new-location");
    });

    it("redirects with 302 status code", async () => {
      const handler = vi.fn((_req: any, res: any) => {
        res.redirect(302, "https://external.com");
      });
      const server = mockServer({ default: handler });
      const req = mockReq("GET", "/api/external");
      const res = mockRes();

      await handleApiRoute(server, req, res, "/api/external", [route("/api/external")]);

      expect(res._statusCode).toBe(302);
      expect(res._headers["location"]).toBe("https://external.com");
    });
  });

  // ── Query and dynamic params ───────────────────────────────────────

  describe("query and dynamic params", () => {
    it("populates req.query from URL query string", async () => {
      let capturedQuery: Record<string, string | string[]> = {};
      const handler = vi.fn((req: any) => {
        capturedQuery = req.query;
      });
      const server = mockServer({ default: handler });
      const req = mockReq("GET", "/api/users?page=2&limit=10");
      const res = mockRes();

      await handleApiRoute(server, req, res, "/api/users?page=2&limit=10", [route("/api/users")]);

      expect(capturedQuery.page).toBe("2");
      expect(capturedQuery.limit).toBe("10");
    });

    it("merges dynamic route params into req.query", async () => {
      let capturedQuery: Record<string, string | string[]> = {};
      const handler = vi.fn((req: any) => {
        capturedQuery = req.query;
      });
      const server = mockServer({ default: handler });
      const req = mockReq("GET", "/api/users/42");
      const res = mockRes();

      await handleApiRoute(server, req, res, "/api/users/42", [route("/api/users/:id")]);

      expect(capturedQuery.id).toBe("42");
    });

    it("merges dynamic params with query string params", async () => {
      let capturedQuery: Record<string, string | string[]> = {};
      const handler = vi.fn((req: any) => {
        capturedQuery = req.query;
      });
      const server = mockServer({ default: handler });
      const req = mockReq("GET", "/api/users/42?fields=name,email");
      const res = mockRes();

      await handleApiRoute(server, req, res, "/api/users/42?fields=name,email", [
        route("/api/users/:id"),
      ]);

      expect(capturedQuery.id).toBe("42");
      expect(capturedQuery.fields).toBe("name,email");
    });

    it("promotes duplicate query keys to arrays", async () => {
      let capturedQuery: Record<string, string | string[]> = {};
      const handler = vi.fn((req: any) => {
        capturedQuery = req.query;
      });
      const server = mockServer({ default: handler });
      const req = mockReq("GET", "/api/users?tag=a&tag=b");
      const res = mockRes();

      await handleApiRoute(server, req, res, "/api/users?tag=a&tag=b", [route("/api/users")]);

      expect(capturedQuery.tag).toEqual(["a", "b"]);
    });

    it("treats prototype property names as ordinary query keys", async () => {
      let capturedQuery: Record<string, string | string[]> = {};
      const handler = vi.fn((req: any) => {
        capturedQuery = req.query;
      });
      const server = mockServer({ default: handler });
      const req = mockReq("GET", "/api/users?toString=a&constructor=b&__proto__=c");
      const res = mockRes();

      await handleApiRoute(server, req, res, "/api/users?toString=a&constructor=b&__proto__=c", [
        route("/api/users"),
      ]);

      expect(capturedQuery["toString"]).toBe("a");
      expect(capturedQuery["constructor"]).toBe("b");
      expect(capturedQuery["__proto__"]).toBe("c");
      expect(Object.getPrototypeOf(capturedQuery)).toBe(Object.prototype);
    });

    it("returns empty query for URL with no query string", async () => {
      let capturedQuery: Record<string, string | string[]> = {};
      const handler = vi.fn((req: any) => {
        capturedQuery = req.query;
      });
      const server = mockServer({ default: handler });
      const req = mockReq("GET", "/api/users");
      const res = mockRes();

      await handleApiRoute(server, req, res, "/api/users", [route("/api/users")]);

      expect(capturedQuery).toEqual({});
    });
  });

  // ── Edge runtime ───────────────────────────────────────────────────

  describe("edge runtime", () => {
    it("calls edge API route handlers with a Fetch Request and writes their Response", async () => {
      // Ported from Next.js: test/e2e/edge-async-local-storage/index.test.ts
      // https://github.com/vercel/next.js/blob/canary/test/e2e/edge-async-local-storage/index.test.ts
      const storage = new AsyncLocalStorage<{ id: string }>();
      const handler = vi.fn((request: Request) => {
        const id = request.headers.get("req-id") ?? "";
        return storage.run({ id }, async () => {
          await Promise.resolve();
          return Response.json(storage.getStore());
        });
      });
      const server = mockServer({
        config: { runtime: "edge" },
        default: handler,
      });
      const req = mockReq("GET", "/api/users", undefined, {
        host: "example.com",
        "req-id": "req-42",
      });
      const res = mockRes();

      const handled = await handleApiRoute(server, req, res, "/api/users", [route("/api/users")]);

      expect(handled).toBe(true);
      expect(handler).toHaveBeenCalledOnce();
      expect(res._statusCode).toBe(200);
      expect(res._headers["content-type"]).toBe("application/json");
      expect(res._body.toString()).toBe(JSON.stringify({ id: "req-42" }));
    });

    it("ignores x-forwarded-proto by default (untrusted proxy) for edge API request URLs", async () => {
      // Regression test for F-PROD-7. Without `VINEXT_TRUST_PROXY` set, an
      // attacker who can reach the dev server directly must not be able to
      // flip `request.url.protocol` to "https:" via a forged header.
      let capturedUrl = "";
      const handler = vi.fn((request: Request) => {
        capturedUrl = request.url;
        return Response.json({ ok: true });
      });
      const server = mockServer({
        config: { runtime: "edge" },
        default: handler,
      });
      const req = mockReq("GET", "/api/users", undefined, {
        host: "example.com",
        "x-forwarded-proto": "https, http",
      });
      const res = mockRes();

      await handleApiRoute(server, req, res, "/api/users?name=alice", [route("/api/users")]);

      expect(capturedUrl).toBe("http://example.com/api/users?name=alice");
    });

    it("falls back to http for unsupported x-forwarded-proto values", async () => {
      let capturedUrl = "";
      const handler = vi.fn((request: Request) => {
        capturedUrl = request.url;
        return Response.json({ ok: true });
      });
      const server = mockServer({
        config: { runtime: "edge" },
        default: handler,
      });
      const req = mockReq("GET", "/api/users", undefined, {
        host: "example.com",
        "x-forwarded-proto": "ftp, https",
      });
      const res = mockRes();

      await handleApiRoute(server, req, res, "/api/users", [route("/api/users")]);

      expect(capturedUrl).toBe("http://example.com/api/users");
    });

    it("preserves multiple Set-Cookie headers from edge API responses", async () => {
      const handler = vi.fn(() => {
        const headers = new Headers();
        headers.append("set-cookie", "one=1; Path=/");
        headers.append("set-cookie", "two=2; Path=/");
        return new Response("ok", { headers });
      });
      const server = mockServer({
        config: { runtime: "edge" },
        default: handler,
      });
      const req = mockReq("GET", "/api/users", undefined, {
        host: "example.com",
      });
      const res = mockRes();

      await handleApiRoute(server, req, res, "/api/users", [route("/api/users")]);

      expect(res._statusCode).toBe(200);
      expect(res._headers["set-cookie"]).toEqual(["one=1; Path=/", "two=2; Path=/"]);
      expect(res._body.toString()).toBe("ok");
    });

    it("streams edge API response bodies through the dev bridge", async () => {
      let releaseSecondChunk!: () => void;
      const secondChunkReady = new Promise<void>((resolve) => {
        releaseSecondChunk = resolve;
      });
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("first"));
          void secondChunkReady.then(() => {
            controller.enqueue(encoder.encode("-second"));
            controller.close();
          });
        },
      });
      const handler = vi.fn(() => new Response(body));
      const server = mockServer({
        config: { runtime: "edge" },
        default: handler,
      });
      const nodeServer = http.createServer((req, res) => {
        handleApiRoute(server, req, res, req.url ?? "/", [route("/api/users")]).catch((error) => {
          if (!res.headersSent) {
            res.writeHead(500);
            res.end(error instanceof Error ? error.message : String(error));
            return;
          }
          res.destroy(error instanceof Error ? error : new Error(String(error)));
        });
      });

      try {
        await new Promise<void>((resolve) => nodeServer.listen(0, resolve));
        const address = nodeServer.address() as AddressInfo;
        const response = await fetch(`http://127.0.0.1:${address.port}/api/users`);
        const reader = response.body?.getReader();
        expect(reader).toBeDefined();
        if (!reader) return;

        const first = await reader.read();
        expect(first.done).toBe(false);
        expect(new TextDecoder().decode(first.value)).toBe("first");

        releaseSecondChunk();
        const second = await reader.read();
        const done = await reader.read();

        expect(second.done).toBe(false);
        expect(new TextDecoder().decode(second.value)).toBe("-second");
        expect(done.done).toBe(true);
      } finally {
        nodeServer.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          nodeServer.close((error) => (error ? reject(error) : resolve()));
        });
      }
    });

    it("passes a NextRequest with nextUrl.searchParams to edge handlers", async () => {
      // Ported from Next.js: test/e2e/edge-pages-support/app/pages/api/hello.js
      // https://github.com/vercel/next.js/blob/canary/test/e2e/edge-pages-support/app/pages/api/hello.js
      // Next.js wraps the incoming Request in a NextRequest before invoking
      // edge API handlers, so handlers can use `req.nextUrl.searchParams`.
      const handler = vi.fn((request: Request) => {
        const nextUrl = (request as { nextUrl?: URL }).nextUrl;
        if (!nextUrl) return new Response("missing nextUrl", { status: 500 });
        return Response.json({
          hello: "world",
          query: Object.fromEntries(nextUrl.searchParams),
        });
      });
      const server = mockServer({
        config: { runtime: "edge" },
        default: handler,
      });
      const req = mockReq("GET", "/api/hello?a=b", undefined, {
        host: "example.com",
      });
      const res = mockRes();

      await handleApiRoute(server, req, res, "/api/hello?a=b", [route("/api/hello")]);

      expect(res._statusCode).toBe(200);
      expect(JSON.parse(res._body.toString())).toEqual({
        hello: "world",
        query: { a: "b" },
      });
    });

    it("recognises bare \"export const runtime = 'edge'\" as an edge API route", async () => {
      // Ported from Next.js: packages/next/src/build/analysis/get-page-static-info.ts
      // Both `export const runtime = "edge"` and `export const config = { runtime: "edge" }`
      // are valid ways to mark a Pages Router API route as edge. Next.js resolves
      // via `config.runtime ?? config.config?.runtime`, so a bare `runtime` export
      // takes precedence over the nested config form.
      const handler = vi.fn((request: Request) =>
        Response.json({ id: request.headers.get("req-id") }),
      );
      const server = mockServer({
        runtime: "edge",
        default: handler,
      });
      const req = mockReq("GET", "/api/users", undefined, {
        host: "example.com",
        "req-id": "req-7",
      });
      const res = mockRes();

      await handleApiRoute(server, req, res, "/api/users", [route("/api/users")]);

      expect(res._statusCode).toBe(200);
      expect(JSON.parse(res._body.toString())).toEqual({ id: "req-7" });
    });

    it("streams edge API request bodies into the handler before the client finishes sending", async () => {
      const decoder = new TextDecoder();
      const handler = vi.fn(async (request: Request) => {
        const reader = request.body?.getReader();
        if (!reader) return new Response("missing body", { status: 400 });
        const first = await reader.read();
        return new Response(first.done ? "done" : decoder.decode(first.value));
      });
      const server = mockServer({
        config: { runtime: "edge" },
        default: handler,
      });
      const nodeServer = http.createServer((req, res) => {
        handleApiRoute(server, req, res, req.url ?? "/", [route("/api/users")]).catch((error) => {
          if (!res.headersSent) {
            res.writeHead(500);
            res.end(error instanceof Error ? error.message : String(error));
            return;
          }
          res.destroy(error instanceof Error ? error : new Error(String(error)));
        });
      });

      try {
        await new Promise<void>((resolve) => nodeServer.listen(0, resolve));
        const address = nodeServer.address() as AddressInfo;
        const req = http.request({
          headers: { "content-type": "text/plain", "transfer-encoding": "chunked" },
          host: "127.0.0.1",
          method: "POST",
          path: "/api/users",
          port: address.port,
        });

        const responseBody = await new Promise<string>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("Timed out waiting for streamed request body response")),
            1000,
          );
          req.on("error", (error) => {
            clearTimeout(timeout);
            reject(error);
          });
          req.on("response", (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("error", (error) => {
              clearTimeout(timeout);
              reject(error);
            });
            response.on("end", () => {
              clearTimeout(timeout);
              resolve(Buffer.concat(chunks).toString("utf-8"));
            });
          });
          req.write("first");
        });

        req.end("-second");
        expect(responseBody).toBe("first");
      } finally {
        nodeServer.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          nodeServer.close((error) => (error ? reject(error) : resolve()));
        });
      }
    });
  });

  // ── Error handling ─────────────────────────────────────────────────

  describe("error handling", () => {
    it("returns 500 when module has no default export", async () => {
      const server = mockServer({ notDefault: () => {} });
      const req = mockReq("GET", "/api/users");
      const res = mockRes();

      const handled = await handleApiRoute(server, req, res, "/api/users", [route("/api/users")]);

      expect(handled).toBe(true);
      expect(res._statusCode).toBe(500);
      expect(res._body).toBe("API route does not export a default function");
    });

    it("returns 500 when default export is not a function", async () => {
      const server = mockServer({ default: "not a function" });
      const req = mockReq("GET", "/api/users");
      const res = mockRes();

      const handled = await handleApiRoute(server, req, res, "/api/users", [route("/api/users")]);

      expect(handled).toBe(true);
      expect(res._statusCode).toBe(500);
      expect(res._body).toBe("API route does not export a default function");
    });

    it("returns 500 when handler throws a generic error", async () => {
      const handler = vi.fn(() => {
        throw new Error("something broke");
      });
      const server = mockServer({ default: handler });
      const req = mockReq("GET", "/api/users");
      const res = mockRes();

      const handled = await handleApiRoute(server, req, res, "/api/users", [route("/api/users")]);

      expect(handled).toBe(true);
      expect(res._statusCode).toBe(500);
      expect(res._body).toBe("Internal Server Error");
    });

    it("still returns 500 on handler errors (no ssrFixStacktrace needed with Module Runner)", async () => {
      const error = new Error("test error");
      const handler = vi.fn(() => {
        throw error;
      });
      const server = mockServer({ default: handler });
      const req = mockReq("GET", "/api/users");
      const res = mockRes();

      await handleApiRoute(server, req, res, "/api/users", [route("/api/users")]);

      expect(res._statusCode).toBe(500);
    });
  });
});
