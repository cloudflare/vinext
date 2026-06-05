import zlib from "node:zlib";
import { type ViteDevServer } from "vite";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { APP_FIXTURE_DIR, startFixtureServer } from "./helpers.js";

describe("App Router external rewrite proxy credential forwarding", () => {
  let mockServer: import("node:http").Server;
  let mockPort: number;
  let capturedHeaders: import("node:http").IncomingHttpHeaders | null = null;
  let capturedUrl: URL | null = null;
  let capturedBody: string | null = null;
  let mockResponseMode: "plain" | "gzipHeaderAndBody" = "plain";
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    // 1. Start a mock HTTP server that captures request headers
    const http = await import("node:http");
    mockServer = http.createServer((req, res) => {
      capturedHeaders = req.headers;
      capturedUrl = new URL(req.url ?? "/", `http://localhost:${mockPort || 80}`);
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        capturedBody = Buffer.concat(chunks).toString("utf8");
        if (mockResponseMode === "gzipHeaderAndBody") {
          const payload = "proxied gzipped body";
          const gzipped = zlib.gzipSync(Buffer.from(payload));
          res.writeHead(200, {
            "Content-Type": "text/plain",
            "Content-Encoding": "gzip",
            "Content-Length": String(gzipped.byteLength),
            "x-custom": "keep-me",
          });
          res.end(gzipped);
          return;
        }
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("proxied ok");
      });
    });
    await new Promise<void>((resolve) => mockServer.listen(0, resolve));
    const addr = mockServer.address();
    mockPort = typeof addr === "object" && addr ? addr.port : 0;

    // 2. Set env var so the app-basic next.config.ts adds the external rewrite
    process.env.TEST_EXTERNAL_PROXY_TARGET = `http://localhost:${mockPort}`;
    process.env.TEST_MIDDLEWARE_EXTERNAL_PROXY_TARGET = `http://localhost:${mockPort}`;

    // 3. Start the App Router dev server (reads next.config.ts at boot)
    ({ server, baseUrl } = await startFixtureServer(APP_FIXTURE_DIR, { appRouter: true }));
  }, 30000);

  afterAll(async () => {
    delete process.env.TEST_EXTERNAL_PROXY_TARGET;
    delete process.env.TEST_MIDDLEWARE_EXTERNAL_PROXY_TARGET;
    await server?.close();
    await new Promise<void>((resolve) => mockServer?.close(() => resolve()));
  });

  it("forwards credential headers and strips x-middleware-* headers from proxied requests to external rewrite targets", async () => {
    mockResponseMode = "plain";
    capturedHeaders = null;
    capturedUrl = null;

    await fetch(`${baseUrl}/proxy-external-test/some-path`, {
      headers: {
        Cookie: "session=secret123",
        Authorization: "Bearer tok_secret",
        "x-api-key": "sk_live_secret",
        "proxy-authorization": "Basic cHJveHk=",
        "x-middleware-next": "1",
        "x-vinext-prerender-secret": "build-secret-123",
        "x-custom-safe": "keep-me",
      },
    });

    expect(capturedHeaders).not.toBeNull();
    // Credential headers must be forwarded to match Next.js external rewrite proxying.
    expect(capturedHeaders!["cookie"]).toBe("session=secret123");
    expect(capturedHeaders!["authorization"]).toBe("Bearer tok_secret");
    expect(capturedHeaders!["x-api-key"]).toBe("sk_live_secret");
    expect(capturedHeaders!["proxy-authorization"]).toBe("Basic cHJveHk=");
    // Internal middleware headers must be stripped
    expect(capturedHeaders!["x-middleware-next"]).toBeUndefined();
    expect(capturedHeaders!["x-vinext-prerender-secret"]).toBeUndefined();
    // Non-sensitive headers must be preserved
    expect(capturedHeaders!["x-custom-safe"]).toBe("keep-me");
  });

  it("preserves repeated query params when proxying to external rewrite targets", async () => {
    mockResponseMode = "plain";
    capturedHeaders = null;
    capturedUrl = null;

    const response = await fetch(`${baseUrl}/proxy-external-test/some-path?a=1&a=2&b=3`);
    expect(response.status).toBe(200);
    expect(capturedUrl).not.toBeNull();
    expect([...capturedUrl!.searchParams.entries()]).toEqual([
      ["a", "1"],
      ["a", "2"],
      ["b", "3"],
    ]);
  });

  // Ported from Next.js: test/e2e/middleware-rewrites/test/index.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/middleware-rewrites/test/index.test.ts
  it("proxies external URLs returned by middleware rewrites with body and headers", async () => {
    mockResponseMode = "plain";
    capturedHeaders = null;
    capturedUrl = null;
    capturedBody = null;

    const body = JSON.stringify({ hello: "world" });
    const response = await fetch(`${baseUrl}/middleware-external-rewrite?via=middleware`, {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        Cookie: "session=secret123",
        "x-from-test": "keep-me",
        "x-middleware-test-rewrite-target": `http://localhost:${mockPort}`,
        "x-middleware-test-request-override": "1",
      },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("proxied ok");
    expect(capturedUrl).not.toBeNull();
    expect(capturedUrl!.pathname).toBe("/middleware-external-target");
    expect([...capturedUrl!.searchParams.entries()]).toEqual([["via", "middleware"]]);
    expect(capturedBody).toBe(body);
    expect(capturedHeaders!["cookie"]).toBe("session=secret123");
    expect(capturedHeaders!["x-from-test"]).toBe("keep-me");
    expect(capturedHeaders!["x-hello-from-middleware1"]).toBe("hello");
    expect(capturedHeaders!["x-hello-from-middleware2"]).toBe("world");
    expect(capturedHeaders!["x-middleware-rewrite"]).toBeUndefined();
    expect(capturedHeaders!["x-middleware-test-rewrite-target"]).toBeUndefined();
    expect(capturedHeaders!["x-middleware-test-request-override"]).toBeUndefined();
    expect(capturedHeaders!["x-vinext-mw-ctx"]).toBeUndefined();
  });

  it("strips content-encoding and content-length for Node fetch auto-decompression", async () => {
    mockResponseMode = "gzipHeaderAndBody";
    const response = await fetch(`${baseUrl}/proxy-external-test/some-path`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("x-custom")).toBe("keep-me");
    expect(await response.text()).toBe("proxied gzipped body");
  });
});

// ---------------------------------------------------------------------------
// generateRscEntry — ISR code generation assertions
// ---------------------------------------------------------------------------
