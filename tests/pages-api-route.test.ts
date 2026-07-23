import { AsyncLocalStorage } from "node:async_hooks";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  handlePagesApiRoute,
  type PagesApiRouteMatch,
} from "../packages/vinext/src/server/pages-api-route.js";

type PagesApiRouteModule = PagesApiRouteMatch["route"]["module"];

function createMatch(
  handler: PagesApiRouteModule["default"],
  params: Record<string, string | string[]> = {},
  moduleConfig?: PagesApiRouteModule["config"],
): PagesApiRouteMatch {
  return {
    params,
    route: {
      pattern: "/api/test",
      module: {
        config: moduleConfig,
        default: handler,
      },
    },
  };
}

describe("pages api route", () => {
  it("does not expose process environment variables on the request", async () => {
    const previousValue = process.env.VINEXT_API_REQUEST_ENV_TEST;
    process.env.VINEXT_API_REQUEST_ENV_TEST = "secret";

    try {
      const response = await handlePagesApiRoute({
        match: createMatch((req, res) => {
          res.json({ hasEnv: Object.hasOwn(req, "env") });
        }),
        request: new Request("https://example.com/api/env"),
        url: "/api/env",
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ hasEnv: false });
    } finally {
      if (previousValue === undefined) {
        delete process.env.VINEXT_API_REQUEST_ENV_TEST;
      } else {
        process.env.VINEXT_API_REQUEST_ENV_TEST = previousValue;
      }
    }
  });

  it("merges dynamic params with duplicate query-string values", async () => {
    const response = await handlePagesApiRoute({
      match: createMatch(
        (req, res) => {
          res.json(req.query);
        },
        { id: "123" },
      ),
      request: new Request("https://example.com/api/users/123?tag=a&tag=b"),
      url: "/api/users/123?tag=a&tag=b",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: "123",
      tag: ["a", "b"],
    });
  });

  it("keeps dynamic params ahead of same-key query-string values", async () => {
    const response = await handlePagesApiRoute({
      match: createMatch(
        (req, res) => {
          res.json(req.query);
        },
        { id: "123" },
      ),
      request: new Request("https://example.com/api/users/123?id=evil&tag=a"),
      url: "/api/users/123?id=evil&tag=a",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: "123",
      tag: "a",
    });
  });

  it("returns 400 with an Invalid JSON statusText for malformed JSON bodies", async () => {
    const response = await handlePagesApiRoute({
      match: createMatch((req, res) => {
        res.json(req.body ?? null);
      }),
      request: new Request("https://example.com/api/parse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"message":Invalid"}',
      }),
      url: "/api/parse",
    });

    expect(response.status).toBe(400);
    expect(response.statusText).toBe("Invalid JSON");
    await expect(response.text()).resolves.toBe("Invalid JSON");
  });

  it("preserves duplicate urlencoded keys and parses empty JSON bodies as {}", async () => {
    const parseHandler = (req: { body: unknown }, res: { json: (data: unknown) => void }) => {
      res.json(req.body ?? null);
    };

    const urlencodedResponse = await handlePagesApiRoute({
      match: createMatch(parseHandler),
      request: new Request("https://example.com/api/parse", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "tag=a&tag=b&tag=c",
      }),
      url: "/api/parse",
    });
    await expect(urlencodedResponse.json()).resolves.toEqual({ tag: ["a", "b", "c"] });

    const emptyJsonResponse = await handlePagesApiRoute({
      match: createMatch(parseHandler),
      request: new Request("https://example.com/api/parse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "",
      }),
      url: "/api/parse",
    });
    await expect(emptyJsonResponse.json()).resolves.toEqual({});
  });

  it("sends Buffer payloads with octet-stream content-type and content-length", async () => {
    const response = await handlePagesApiRoute({
      match: createMatch((_req, res) => {
        res.send(Buffer.from([1, 2, 3]));
      }),
      request: new Request("https://example.com/api/send-buffer"),
      url: "/api/send-buffer",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-length")).toBe("3");
    expect(Buffer.from(await response.arrayBuffer()).equals(Buffer.from([1, 2, 3]))).toBe(true);
  });

  it("reports thrown handler errors and returns a 500 response", async () => {
    const reportRequestError = vi.fn();

    const response = await handlePagesApiRoute({
      match: createMatch(() => {
        throw new Error("boom");
      }),
      reportRequestError,
      request: new Request("https://example.com/api/fail"),
      url: "/api/fail",
    });

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toBe("Internal Server Error");
    expect(reportRequestError).toHaveBeenCalledWith(expect.any(Error), "/api/test");
  });

  it("returns 413 when the API body exceeds the default size limit", async () => {
    const response = await handlePagesApiRoute({
      match: createMatch((_req, res) => {
        res.status(200).json({ ok: true });
      }),
      request: new Request("https://example.com/api/parse", {
        method: "POST",
        headers: {
          "content-length": String(2 * 1024 * 1024),
          "content-type": "application/json",
        },
        body: "{}",
      }),
      url: "/api/parse",
    });

    expect(response.status).toBe(413);
    await expect(response.text()).resolves.toBe("Request body too large");
  });

  it("returns 404 when match is null", async () => {
    const response = await handlePagesApiRoute({
      match: null,
      request: new Request("https://example.com/api/not-found"),
      url: "/api/not-found",
    });

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("404 - API route not found");
  });

  it("returns 500 when the route module has no default export", async () => {
    const response = await handlePagesApiRoute({
      match: {
        params: {},
        route: {
          pattern: "/api/no-export",
          module: {},
        },
      },
      request: new Request("https://example.com/api/no-export"),
      url: "/api/no-export",
    });

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toBe("API route does not export a default function");
  });

  it("res.redirect() uses 307 by default and 2-arg form uses the given status", async () => {
    let defaultReturnedResponse: unknown;
    let defaultHandlerResponse: unknown;
    const defaultRedirectResponse = await handlePagesApiRoute({
      match: createMatch((_req, res) => {
        defaultHandlerResponse = res;
        defaultReturnedResponse = res.redirect("/new-path");
      }),
      request: new Request("https://example.com/api/redir"),
      url: "/api/redir",
    });

    expect(defaultRedirectResponse.status).toBe(307);
    expect(defaultRedirectResponse.headers.get("location")).toBe("/new-path");
    expect(defaultRedirectResponse.headers.get("content-type")).toBeNull();
    await expect(defaultRedirectResponse.text()).resolves.toBe("/new-path");
    expect(defaultReturnedResponse).toBe(defaultHandlerResponse);

    let customReturnedResponse: unknown;
    let customHandlerResponse: unknown;
    const customRedirectResponse = await handlePagesApiRoute({
      match: createMatch((_req, res) => {
        customHandlerResponse = res;
        customReturnedResponse = res.redirect(301, "/permanent");
      }),
      request: new Request("https://example.com/api/redir"),
      url: "/api/redir",
    });

    expect(customRedirectResponse.status).toBe(301);
    expect(customRedirectResponse.headers.get("location")).toBe("/permanent");
    expect(customRedirectResponse.headers.get("content-type")).toBeNull();
    await expect(customRedirectResponse.text()).resolves.toBe("/permanent");
    expect(customReturnedResponse).toBe(customHandlerResponse);
  });

  it.each([
    [null, undefined],
    [307, undefined],
    [true, "/destination"],
  ])("res.redirect() rejects invalid arguments %#", async (statusOrUrl, url) => {
    const response = await handlePagesApiRoute({
      match: createMatch((_req, res) => {
        res.redirect(statusOrUrl as string | number, url);
      }),
      request: new Request("https://example.com/api/redir"),
      url: "/api/redir",
    });

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toBe("Internal Server Error");
  });

  it("res.revalidate() uses the trusted origin instead of the request host", async () => {
    const originalFetch = globalThis.fetch;
    let capturedUrl: URL | undefined;
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl =
        typeof input === "string"
          ? new URL(input)
          : input instanceof URL
            ? input
            : new URL(input.url);
      expect(input instanceof Request ? input.method : init?.method).toBe("HEAD");
      return new Response(null, { status: 200 });
    };

    try {
      const response = await handlePagesApiRoute({
        match: createMatch(async (_req, res) => {
          await res.revalidate("/fixed-page");
          res.json({ revalidated: true });
        }),
        request: new Request("http://127.0.0.1:9999/api/revalidate"),
        trustedRevalidateOrigin: "http://app.local:3000",
        url: "/api/revalidate",
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ revalidated: true });
      expect(capturedUrl?.href).toBe("http://app.local:3000/fixed-page");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("res.revalidate() ignores Host header spoofing in Fetch request adapters", async () => {
    const originalFetch = globalThis.fetch;
    let capturedUrl: URL | undefined;
    globalThis.fetch = async (input: string | URL | Request) => {
      capturedUrl =
        typeof input === "string"
          ? new URL(input)
          : input instanceof URL
            ? input
            : new URL(input.url);
      return new Response(null, { status: 200 });
    };

    try {
      const response = await handlePagesApiRoute({
        match: createMatch(async (_req, res) => {
          await res.revalidate("/fixed-page");
          res.json({ revalidated: true });
        }),
        request: new Request("http://app.local:3000/api/revalidate", {
          headers: { host: "127.0.0.1:9999" },
        }),
        url: "/api/revalidate",
      });

      expect(response.status).toBe(200);
      expect(capturedUrl?.href).toBe("http://app.local:3000/fixed-page");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("res.writeHead() lowercases header keys and joins array values", async () => {
    const response = await handlePagesApiRoute({
      match: createMatch((_req, res) => {
        res.writeHead(200, { "X-Custom": "value", "X-Multi": ["a", "b"] });
        res.end();
      }),
      request: new Request("https://example.com/api/headers"),
      url: "/api/headers",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-custom")).toBe("value");
    expect(response.headers.get("x-multi")).toBe("a, b");
  });

  it("res.writeHead() replaces previously set Set-Cookie headers (Node.js parity)", async () => {
    const response = await handlePagesApiRoute({
      match: createMatch((_req, res) => {
        res.setHeader("Set-Cookie", "existing=1");
        res.writeHead(200, {
          "Set-Cookie": ["replacement=2", "replacement-extra=3"],
        });
        res.end();
      }),
      request: new Request("https://example.com/api/cookie"),
      url: "/api/cookie",
    });

    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toEqual(["replacement=2", "replacement-extra=3"]);
  });

  it("res.setHeader and res.getHeader round-trip correctly", async () => {
    const response = await handlePagesApiRoute({
      match: createMatch((_req, res) => {
        res.setHeader("x-foo", "bar");
        const val = res.getHeader("x-foo");
        res.json({ val });
      }),
      request: new Request("https://example.com/api/roundtrip"),
      url: "/api/roundtrip",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ val: "bar" });
  });

  it("res.setHeader replaces set-cookie on repeated calls (Node.js parity)", async () => {
    const response = await handlePagesApiRoute({
      match: createMatch((_req, res) => {
        res.setHeader("set-cookie", "session=abc");
        res.setHeader("set-cookie", "session=xyz"); // should replace, not append
        res.end();
      }),
      request: new Request("https://example.com/api/cookie"),
      url: "/api/cookie",
    });

    expect(response.status).toBe(200);
    // Only one set-cookie header — the replacement
    const cookies = response.headers.getSetCookie();
    expect(cookies).toEqual(["session=xyz"]);
  });

  it("preserves Set-Cookie values when a caller mutates and resets the getHeader array", async () => {
    const response = await handlePagesApiRoute({
      match: createMatch((_req, res) => {
        // Matches next-auth v4's setCookie helper:
        // https://github.com/nextauthjs/next-auth/blob/next-auth%404.24.13/packages/next-auth/src/next/utils.ts#L5-L15
        const appendCookie = (cookie: string) => {
          let cookies = res.getHeader("Set-Cookie") ?? [];
          if (!Array.isArray(cookies)) {
            cookies = [String(cookies)];
          }
          cookies.push(cookie);
          res.setHeader("Set-Cookie", cookies);
        };

        appendCookie("a=1; Path=/");
        appendCookie("b=2; Path=/");
        res.end();
      }),
      request: new Request("https://example.com/api/cookie"),
      url: "/api/cookie",
    });

    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });

  it("calls edge API route handlers with a Fetch Request and returns their Response", async () => {
    // Ported from Next.js: test/e2e/edge-async-local-storage/index.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/edge-async-local-storage/index.test.ts
    const response = await handlePagesApiRoute({
      match: createMatch(
        (request: Request) => {
          const id = request.headers.get("req-id");
          return Response.json({ id });
        },
        {},
        { runtime: "edge" },
      ),
      request: new Request("https://example.com/api/test", {
        headers: { "req-id": "req-42" },
      }),
      url: "/api/test",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: "req-42" });
  });

  it("removes stale encoding headers after Node fetch decodes an edge API response", async () => {
    // Ported from Next.js: packages/next/src/server/web/sandbox/sandbox.ts
    // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/web/sandbox/sandbox.ts
    const body = "Example Domain";
    const compressedBody = gzipSync(body);
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200, {
        "content-encoding": "gzip",
        "content-length": String(compressedBody.byteLength),
        "content-type": "text/plain",
      });
      res.end(compressedBody);
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));

    try {
      const address = upstream.address() as AddressInfo;
      const response = await handlePagesApiRoute({
        edgeRuntime: "node",
        match: createMatch(
          () => fetch(`http://127.0.0.1:${address.port}`),
          {},
          { runtime: "edge" },
        ),
        request: new Request("https://example.com/api/proxy"),
        url: "/api/proxy",
      });

      expect(response.headers.get("content-encoding")).toBeNull();
      expect(response.headers.get("content-length")).toBeNull();
      await expect(response.text()).resolves.toBe(body);
    } finally {
      upstream.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        upstream.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("preserves encoded edge API responses in the Worker runtime", async () => {
    const body = gzipSync("Example Domain");
    const response = await handlePagesApiRoute({
      edgeRuntime: "worker",
      match: createMatch(
        () =>
          new Response(body, {
            headers: {
              "content-encoding": "gzip",
              "content-length": String(body.byteLength),
              "content-type": "text/plain",
            },
          }),
        {},
        { runtime: "edge" },
      ),
      request: new Request("https://example.com/api/proxy"),
      url: "/api/proxy",
    });

    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(response.headers.get("content-length")).toBe(String(body.byteLength));
    expect(Buffer.from(await response.arrayBuffer())).toEqual(body);
  });

  it("passes a NextRequest with nextUrl.searchParams to edge API handlers", async () => {
    // Ported from Next.js: test/e2e/edge-pages-support/app/pages/api/hello.js
    // https://github.com/vercel/next.js/blob/canary/test/e2e/edge-pages-support/app/pages/api/hello.js
    // Next.js wraps the request in a NextRequest before invoking the user's
    // edge API handler, so handlers can use `req.nextUrl.searchParams`.
    const response = await handlePagesApiRoute({
      match: createMatch(
        (request: Request) => {
          const nextUrl = (request as Request & { nextUrl?: URL }).nextUrl;
          if (!nextUrl) {
            return new Response("missing nextUrl", { status: 500 });
          }
          return Response.json({
            hello: "world",
            query: Object.fromEntries(nextUrl.searchParams),
          });
        },
        {},
        { runtime: "edge" },
      ),
      request: new Request("https://example.com/api/hello?a=b"),
      url: "/api/hello?a=b",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      hello: "world",
      query: { a: "b" },
    });
  });

  it("passes the resolved query while preserving the original edge API pathname", async () => {
    // Ported from Next.js: test/e2e/middleware-general/test/index.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/middleware-general/test/index.test.ts
    //
    // Upstream middleware mutates request.nextUrl.searchParams and rewrites to
    // the same edge Pages API route. The handler's req.nextUrl must reflect the
    // resolved rewrite URL, not the original incoming Request URL.
    const response = await handlePagesApiRoute({
      match: createMatch(
        (request: Request) => {
          const nextUrl = (request as Request & { nextUrl?: URL }).nextUrl;
          if (!nextUrl) {
            return new Response("missing nextUrl", { status: 500 });
          }
          return Response.json({
            pathname: nextUrl.pathname,
            query: Object.fromEntries(nextUrl.searchParams),
          });
        },
        {},
        { runtime: "edge" },
      ),
      request: new Request("https://example.com/public-edge-path?a=b"),
      url: "/api/edge-search-params?a=b&foo=bar",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      pathname: "/public-edge-path",
      query: {
        a: "b",
        foo: "bar",
      },
    });
  });

  it("includes dynamic route params in edge API nextUrl.searchParams", async () => {
    // Ported from Next.js: test/e2e/edge-pages-support/index.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/edge-pages-support/index.test.ts
    const response = await handlePagesApiRoute({
      match: createMatch(
        (request: Request) => {
          const nextUrl = (request as Request & { nextUrl?: URL }).nextUrl;
          if (!nextUrl) {
            return new Response("missing nextUrl", { status: 500 });
          }
          return Response.json(Object.fromEntries(nextUrl.searchParams));
        },
        { id: "id-1" },
        { runtime: "edge" },
      ),
      request: new Request("https://example.com/api/id-1?a=b"),
      url: "/api/id-1?a=b",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      a: "b",
      id: "id-1",
    });
  });

  it("applies basePath and i18n config to edge API nextUrl", async () => {
    const response = await handlePagesApiRoute({
      match: createMatch(
        (request: Request) => {
          const nextUrl = (
            request as Request & {
              nextUrl?: { basePath: string; locale: string; pathname: string };
            }
          ).nextUrl;
          return Response.json({
            basePath: nextUrl?.basePath,
            locale: nextUrl?.locale,
            pathname: nextUrl?.pathname,
          });
        },
        {},
        { runtime: "edge" },
      ),
      nextConfig: {
        basePath: "/docs",
        i18n: { defaultLocale: "en", locales: ["en", "fr"] },
      },
      request: new Request("https://example.com/docs/fr/api/hello?a=b"),
      url: "/fr/api/hello?a=b",
    });

    await expect(response.json()).resolves.toMatchObject({
      basePath: "/docs",
      locale: "fr",
      pathname: "/api/hello",
    });
  });

  it("preserves edge API request properties when applying the resolved URL", async () => {
    const request = new Request("https://example.com/api/edge-search-params?a=b", {
      body: "payload",
      headers: { "x-test": "1" },
      method: "POST",
    });
    Object.defineProperty(request, "cf", {
      configurable: true,
      enumerable: true,
      value: { country: "US" },
    });
    const response = await handlePagesApiRoute({
      match: createMatch(
        async (request: Request) => {
          const nextUrl = (request as Request & { nextUrl?: URL }).nextUrl;
          if (!nextUrl) {
            return new Response("missing nextUrl", { status: 500 });
          }
          return Response.json({
            body: await request.text(),
            header: request.headers.get("x-test"),
            method: request.method,
            query: Object.fromEntries(nextUrl.searchParams),
            cf: Reflect.get(request, "cf"),
          });
        },
        {},
        { runtime: "edge" },
      ),
      request,
      url: "/api/edge-search-params?a=b&foo=bar",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      body: "payload",
      cf: { country: "US" },
      header: "1",
      method: "POST",
      query: {
        a: "b",
        foo: "bar",
      },
    });
  });

  it("recognises bare \"export const runtime = 'edge'\" as an edge API route", async () => {
    // Ported from Next.js: packages/next/src/build/analysis/get-page-static-info.ts
    // Both `export const runtime = "edge"` and `export const config = { runtime: "edge" }`
    // are valid ways to mark a Pages Router API route as edge. Next.js resolves
    // via `config.runtime ?? config.config?.runtime`.
    const response = await handlePagesApiRoute({
      match: {
        params: {},
        route: {
          pattern: "/api/edge-bare",
          module: {
            runtime: "edge",
            default: (request: Request) => Response.json({ ok: true, kind: typeof request }),
          } as unknown as PagesApiRouteModule,
        },
      },
      request: new Request("https://example.com/api/edge-bare"),
      url: "/api/edge-bare",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, kind: "object" });
  });

  it("preserves nested AsyncLocalStorage state across concurrent edge API requests", async () => {
    // Ported from Next.js: test/e2e/edge-async-local-storage/index.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/edge-async-local-storage/index.test.ts
    const topStorage = new AsyncLocalStorage<{ id: string }>();
    const ids = Array.from({ length: 100 }, (_, i) => `req-${i}`);

    const responses = await Promise.all(
      ids.map((id) =>
        handlePagesApiRoute({
          match: createMatch(
            (request: Request) => {
              const requestId = request.headers.get("req-id") ?? "";
              return topStorage.run({ id: requestId }, async () => {
                const nestedStorage = new AsyncLocalStorage<string>();
                const nested = await nestedStorage.run(`nested-${requestId}`, async () => {
                  await Promise.resolve();
                  return { nestedId: nestedStorage.getStore() };
                });

                await Promise.resolve();
                return Response.json({ ...nested, ...topStorage.getStore() });
              });
            },
            {},
            { runtime: "experimental-edge" },
          ),
          request: new Request("https://example.com/api/test", {
            headers: { "req-id": id },
          }),
          url: "/api/test",
        }),
      ),
    );

    for (const [index, response] of responses.entries()) {
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        id: ids[index],
        nestedId: `nested-${ids[index]}`,
      });
    }
  });

  it("auto-ends the response when a handler returns a non-stream value and does not call res.end()", async () => {
    // Regression: handlers that return a plain value (e.g. a number) and
    // forget to call res.end() must not hang the request. Auto-end is
    // gated on the "pipe" event only — return values do not defer it.
    const response = await handlePagesApiRoute({
      match: createMatch((_req, res) => {
        res.status(202);
        return 42;
      }),
      request: new Request("https://example.com/api/non-stream-return"),
      url: "/api/non-stream-return",
    });

    expect(response.status).toBe(202);
    await expect(response.text()).resolves.toBe("");
  });

  it("auto-ends when a handler returns the response object without piping or sending", async () => {
    // Regression: chainable helpers like `return res.status(202)` return
    // `this` (the response object), but that does not mean streaming is
    // in progress. Only the "pipe" event should defer auto-ending.
    const response = await handlePagesApiRoute({
      match: createMatch((_req, res) => res.status(202)),
      request: new Request("https://example.com/api/return-res-status"),
      url: "/api/return-res-status",
    });

    expect(response.status).toBe(202);
    await expect(response.text()).resolves.toBe("");
  });

  it("streams multi-chunk res.write() / res.end() through a ReadableStream body", async () => {
    let headersSentAfterWrite = false;
    const response = await handlePagesApiRoute({
      match: createMatch((_req, res) => {
        res.write("chunk-1");
        headersSentAfterWrite = res.headersSent;
        res.write("chunk-2");
        res.write("chunk-3");
        res.end();
      }),
      request: new Request("https://example.com/api/multi-chunk"),
      url: "/api/multi-chunk",
    });

    expect(response.status).toBe(200);
    expect(headersSentAfterWrite).toBe(true);
    await expect(response.text()).resolves.toBe("chunk-1chunk-2chunk-3");
  });

  it("does not accumulate chunks after the response body is cancelled", async () => {
    let resRef: any;

    const response = await handlePagesApiRoute({
      match: createMatch((_req, res) => {
        resRef = res;
        res.write("first");
        // Keep the stream open so the test can cancel the body before the
        // Node side finishes.
      }),
      request: new Request("https://example.com/api/cancel"),
      url: "/api/cancel",
    });

    const reader = response.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe("first");

    await reader.cancel();

    // After the Fetch body is cancelled, the Node-compatible writable must
    // reject further writes instead of silently buffering them.
    const writeErr = await new Promise<Error | null>((resolve) => {
      resRef.write("second", (err: Error | null) => resolve(err));
    });

    expect(writeErr).toBeInstanceOf(Error);
    expect(writeErr!.message).toMatch(/Cannot call write after a stream was destroyed/);
  });

  it("returns a 500 when the response stream is destroyed with an error before any body has been written", async () => {
    const reportRequestError = vi.fn();

    const response = await handlePagesApiRoute({
      match: createMatch(
        (_req, res) => {
          // Simulate a proxy handler where the upstream errors and the
          // handler forwards the error to the response stream before
          // anything is written. In this case the responsePromise should
          // reject and the normal 500 error path in handlePagesApiRoute
          // should surface.
          res.destroy(new Error("upstream exploded"));
          return res;
        },
        {},
        { api: { bodyParser: false } },
      ),
      reportRequestError,
      request: new Request("https://example.com/api/stream-error", {
        method: "POST",
        body: "some-body",
      }),
      url: "/api/stream-error",
    });

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toBe("Internal Server Error");
    expect(reportRequestError).toHaveBeenCalledWith(expect.any(Error), "/api/test");
  });

  it("does not hang when the response stream is destroyed after partial output has started", async () => {
    // Regression: after the first write, the Fetch Response has already been
    // resolved. Destroying the Node-compatible res must error the body
    // ReadableStream so the consumer sees a failure instead of an open
    // stream that never terminates.
    const response = await handlePagesApiRoute({
      match: createMatch(
        (_req, res) => {
          res.write("partial");
          res.destroy(new Error("upstream exploded"));
          return res;
        },
        {},
        { api: { bodyParser: false } },
      ),
      request: new Request("https://example.com/api/stream-error-partial"),
      url: "/api/stream-error-partial",
    });

    expect(response.status).toBe(200);
    // The body stream should reject because it was destroyed mid-stream.
    await expect(response.text()).rejects.toThrow("upstream exploded");
  });

  it("does not hang when res.destroy() is called without an error before any body is written", async () => {
    // Regression: destroy() with no error before resolveOnce() must still
    // resolve the response promise so the request does not hang.
    const response = await handlePagesApiRoute({
      match: createMatch((_req, res) => {
        res.destroy();
        return res;
      }),
      request: new Request("https://example.com/api/destroy-no-error"),
      url: "/api/destroy-no-error",
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("");
  });

  it("settles the response only once when res.destroy() is called repeatedly", async () => {
    const response = await handlePagesApiRoute({
      match: createMatch((_req, res) => {
        res.destroy();
        res.destroy(new Error("second destroy must be ignored"));
        return res;
      }),
      request: new Request("https://example.com/api/destroy-idempotent"),
      url: "/api/destroy-idempotent",
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("");
  });

  it("does not auto-end when the handler pipes into res without returning it", async () => {
    const body = "raw-body-data";
    const response = await handlePagesApiRoute({
      match: createMatch(
        (req, res) => {
          // Handler pipes req through a transform into res, matching the
          // real-world pattern: a webhook handler forwarding the raw body
          // upstream without returning the pipe chain.
          req.pipe(new PassThrough()).pipe(res);
          // Note: does NOT return res — handler returns undefined.
        },
        {},
        { api: { bodyParser: false } },
      ),
      request: new Request("https://example.com/api/pipe-no-return", {
        method: "POST",
        body,
      }),
      url: "/api/pipe-no-return",
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(body);
  });

  it("streams a piped request body through to the response", async () => {
    const body = "piped-body-content";
    const response = await handlePagesApiRoute({
      match: createMatch(
        (req, res) => {
          // Handler pipes req directly to res and returns the result,
          // matching the fixture pattern in the upstream PR.
          const result = req.pipe(new PassThrough()).pipe(res);
          return result;
        },
        {},
        { api: { bodyParser: false } },
      ),
      request: new Request("https://example.com/api/pipe-with-return", {
        method: "POST",
        body,
      }),
      url: "/api/pipe-with-return",
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(body);
  });

  it("exposes the raw body as a byte-mode stream of Buffer chunks", async () => {
    // Parity: Node `IncomingMessage` is a non-objectMode stream yielding
    // `Buffer`s. Handlers routinely call `chunk.toString("utf8")` per chunk
    // (webhook signature verification etc.) — on a raw Uint8Array that
    // comma-joins byte values instead of decoding.
    const body = "buffer-parity-body";
    let objectMode: boolean | undefined;
    let allBuffers = true;

    const response = await handlePagesApiRoute({
      match: createMatch(
        async (req, res) => {
          objectMode = req.readableObjectMode;
          let text = "";
          for await (const chunk of req) {
            allBuffers &&= Buffer.isBuffer(chunk);
            text += chunk.toString("utf8");
          }
          res.send(text);
        },
        {},
        { api: { bodyParser: false } },
      ),
      request: new Request("https://example.com/api/buffer-chunks", {
        method: "POST",
        body,
      }),
      url: "/api/buffer-chunks",
    });

    expect(response.status).toBe(200);
    expect(objectMode).toBe(false);
    expect(allBuffers).toBe(true);
    await expect(response.text()).resolves.toBe(body);
  });

  it("does not auto-end when config.api.externalResolver is true and the handler responds late", async () => {
    // Parity: Next.js never auto-ends a response — `externalResolver: true`
    // is the documented contract for handlers (e.g. proxy middleware) that
    // send the response after the handler's promise settles. Without the
    // flag the auto-end safety net would resolve an empty 200 first.
    const response = await handlePagesApiRoute({
      match: createMatch(
        (_req, res) => {
          setTimeout(() => {
            res.status(201).json({ late: true });
          }, 10);
          // Returns before anything is written or piped.
        },
        {},
        { api: { externalResolver: true } },
      ),
      request: new Request("https://example.com/api/external-resolver"),
      url: "/api/external-resolver",
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ late: true });
  });
});
