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
import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import http from "node:http";
import { handleApiRoute } from "../packages/vinext/src/server/api-handler.js";
import type { Route } from "../packages/vinext/src/routing/pages-router.js";
import type { ViteDevServer } from "vite";

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
  _body: string;
  _headers: Record<string, string>;
  _statusCode: number;
  _ended: boolean;
} {
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    _body: "",
    _headers: headers,
    _statusCode: 200,
    _ended: false,
    setHeader(name: string, value: string) {
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
    end(data?: string) {
      if (data !== undefined) {
        res._body = data;
      }
      res._ended = true;
      res._statusCode = res.statusCode;
    },
  } as unknown as http.ServerResponse & {
    _body: string;
    _headers: Record<string, string>;
    _statusCode: number;
    _ended: boolean;
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
 * Build a minimal mock ViteDevServer with configurable ssrLoadModule behavior.
 */
function mockServer(moduleExport: Record<string, unknown>): ViteDevServer {
  return {
    ssrLoadModule: vi.fn().mockResolvedValue(moduleExport),
    ssrFixStacktrace: vi.fn(),
  } as unknown as ViteDevServer;
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

    it("falls back to raw string for malformed JSON", async () => {
      let capturedBody: unknown;
      const handler = vi.fn((req: any) => {
        capturedBody = req.body;
      });
      const server = mockServer({ default: handler });
      const req = mockReq("POST", "/api/users", "{not json", {
        "content-type": "application/json",
      });
      const res = mockRes();

      await handleApiRoute(server, req, res, "/api/users", [route("/api/users")]);

      expect(capturedBody).toBe("{not json");
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
      expect(JSON.parse(res._body)).toEqual({ ok: true });
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
      expect(JSON.parse(res._body)).toEqual({ message: "hello" });
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

      expect(JSON.parse(res._body)).toEqual(data);
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
      expect(JSON.parse(res._body)).toEqual({ key: "value" });
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

    it("calls ssrFixStacktrace on handler errors", async () => {
      const error = new Error("test error");
      const handler = vi.fn(() => {
        throw error;
      });
      const server = mockServer({ default: handler });
      const req = mockReq("GET", "/api/users");
      const res = mockRes();

      await handleApiRoute(server, req, res, "/api/users", [route("/api/users")]);

      expect(server.ssrFixStacktrace).toHaveBeenCalledWith(error);
    });
  });
});
