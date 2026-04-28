import { Transform } from "node:stream";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  handlePagesApiRoute,
  type PagesApiRouteMatch,
} from "../packages/vinext/src/server/pages-api-route.js";
import type {
  PagesReqResRequest,
  PagesReqResResponse,
} from "../packages/vinext/src/server/pages-node-compat.js";
import type { NextRequest } from "../packages/vinext/src/shims/server.js";

type TestPagesApiHandler = (
  req: PagesReqResRequest,
  res: PagesReqResResponse,
) => unknown | Promise<unknown>;

function createMatch(
  handler: TestPagesApiHandler,
  params: Record<string, string | string[]> = {},
  moduleOverrides: Partial<PagesApiRouteMatch["route"]["module"]> = {},
): PagesApiRouteMatch {
  return {
    params,
    route: {
      pattern: "/api/test",
      module: {
        ...moduleOverrides,
        default: handler,
      },
    },
  };
}

describe("pages api route", () => {
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

  it("calls edge runtime Pages API routes with NextRequest", async () => {
    // Ported from Next.js deploy fixture:
    // test/e2e/middleware-general/app/pages/api/edge-search-params.js
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await handlePagesApiRoute({
      match: {
        params: {},
        route: {
          pattern: "/api/edge-search-params",
          module: {
            config: { runtime: "edge" },
            default(req: NextRequest) {
              return Response.json(Object.fromEntries((req as any).nextUrl.searchParams));
            },
          },
        },
      },
      request: new Request("https://example.com/api/edge-search-params?hello=world"),
      url: "/api/edge-search-params?hello=world&foo=bar",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ foo: "bar", hello: "world" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('config.runtime = "edge"'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("https://nextjs.org/blog/next-16"));
    warn.mockRestore();
  });

  it("adds dynamic params to edge runtime Pages API nextUrl search params", async () => {
    // Ported from Next.js: test/e2e/edge-pages-support/index.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/edge-pages-support/index.test.ts
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await handlePagesApiRoute({
      match: {
        params: { id: "id-1" },
        route: {
          pattern: "/api/[id]",
          module: {
            config: { runtime: "edge" },
            default(req: NextRequest) {
              return Response.json(Object.fromEntries((req as any).nextUrl.searchParams));
            },
          },
        },
      },
      request: new Request("https://example.com/api/id-1?a=b"),
      url: "/api/id-1?a=b",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ a: "b", id: "id-1" });
    warn.mockRestore();
  });

  it("exposes AsyncLocalStorage as an edge runtime global", async () => {
    // Ported from Next.js: test/e2e/edge-async-local-storage/index.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/edge-async-local-storage/index.test.ts
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "AsyncLocalStorage");
    Reflect.deleteProperty(globalThis, "AsyncLocalStorage");

    try {
      const { installEdgeRuntimeGlobals } =
        await import("../packages/vinext/src/server/edge-runtime-globals.js");
      installEdgeRuntimeGlobals();

      const AsyncLocalStorageGlobal = (
        globalThis as typeof globalThis & {
          AsyncLocalStorage: new <T>() => {
            getStore(): T | undefined;
            run<R>(store: T, callback: () => R): R;
          };
        }
      ).AsyncLocalStorage;
      const storage = new AsyncLocalStorageGlobal<{ id: string }>();

      await storage.run({ id: "req-1" }, async () => {
        await Promise.resolve();
        expect(storage.getStore()).toEqual({ id: "req-1" });
      });
    } finally {
      if (descriptor) {
        Object.defineProperty(globalThis, "AsyncLocalStorage", descriptor);
      } else {
        Reflect.deleteProperty(globalThis, "AsyncLocalStorage");
      }
    }
  });

  it("recognizes top-level runtime = edge exports", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await handlePagesApiRoute({
      match: {
        params: {},
        route: {
          pattern: "/api/top-level-edge",
          module: {
            runtime: "edge",
            default() {
              return Response.json({ ok: true });
            },
          },
        },
      },
      request: new Request("https://example.com/api/top-level-edge"),
      url: "/api/top-level-edge",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    warn.mockRestore();
  });

  it("treats config.runtime = experimental-edge as an edge-style Pages API route", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await handlePagesApiRoute({
      match: {
        params: {},
        route: {
          pattern: "/api/experimental-edge",
          module: {
            config: { runtime: "experimental-edge" },
            default() {
              return Response.json({ ok: true });
            },
          },
        },
      },
      request: new Request("https://example.com/api/experimental-edge"),
      url: "/api/experimental-edge",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    warn.mockRestore();
  });

  it("strips encoded body headers from edge runtime Pages API responses", async () => {
    // Ported from Next.js: test/e2e/edge-compiler-can-import-blob-assets/index.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/edge-compiler-can-import-blob-assets/index.test.ts
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await handlePagesApiRoute({
      match: {
        params: {},
        route: {
          pattern: "/api/edge",
          module: {
            config: { runtime: "edge" },
            default() {
              return new Response("<!doctype html>Example Domain", {
                headers: {
                  "content-encoding": "br",
                  "content-length": "999",
                  "content-type": "text/html; charset=utf-8",
                },
              });
            },
          },
        },
      },
      request: new Request("https://example.com/api/edge"),
      url: "/api/edge",
    });

    expect(response.headers.has("content-encoding")).toBe(false);
    expect(response.headers.has("content-length")).toBe(false);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    await expect(response.text()).resolves.toContain("Example Domain");
    warn.mockRestore();
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

  it("honors route-level bodyParser sizeLimit config", async () => {
    const response = await handlePagesApiRoute({
      match: createMatch(
        (_req, res) => {
          res.status(200).json({ ok: true });
        },
        {},
        { config: { api: { bodyParser: { sizeLimit: "5kb" } } } },
      ),
      request: new Request("https://example.com/api/parse", {
        method: "POST",
        headers: {
          "content-length": String(5 * 1024 + 1),
          "content-type": "text/plain",
        },
        body: "x",
      }),
      url: "/api/parse",
    });

    expect(response.status).toBe(413);
    await expect(response.text()).resolves.toBe("Request body too large");
  });

  it("leaves body unparsed and exposes a raw async iterable when bodyParser is false", async () => {
    const response = await handlePagesApiRoute({
      match: createMatch(
        async (req, res) => {
          const chunks: Buffer[] = [];
          for await (const chunk of req as AsyncIterable<Buffer>) {
            chunks.push(chunk);
          }
          res.json({ body: req.body, rawBody: Buffer.concat(chunks).toString("utf8") });
        },
        {},
        { config: { api: { bodyParser: false } } },
      ),
      request: new Request("https://example.com/api/raw", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "hello raw body",
      }),
      url: "/api/raw",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ rawBody: "hello raw body" });
  });

  it("supports piping raw Pages API requests into streamed responses", async () => {
    // Ported from Next.js: test/e2e/proxy-request-with-middleware/test/index.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/proxy-request-with-middleware/test/index.test.ts
    const response = await handlePagesApiRoute({
      match: createMatch(
        (req, res) => {
          const passthrough = new Transform({
            transform(chunk, _encoding, callback) {
              callback(null, chunk);
            },
          });

          return req.pipe(passthrough).pipe(res);
        },
        {},
        { config: { api: { bodyParser: false } } },
      ),
      request: new Request("https://example.com/api/raw", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"key":"value"}',
      }),
      url: "/api/raw",
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('{"key":"value"}');
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
    const defaultRedirectResponse = await handlePagesApiRoute({
      match: createMatch((_req, res) => {
        res.redirect("/new-path");
      }),
      request: new Request("https://example.com/api/redir"),
      url: "/api/redir",
    });

    expect(defaultRedirectResponse.status).toBe(307);
    expect(defaultRedirectResponse.headers.get("location")).toBe("/new-path");

    const customRedirectResponse = await handlePagesApiRoute({
      match: createMatch((_req, res) => {
        res.redirect(301, "/permanent");
      }),
      request: new Request("https://example.com/api/redir"),
      url: "/api/redir",
    });

    expect(customRedirectResponse.status).toBe(301);
    expect(customRedirectResponse.headers.get("location")).toBe("/permanent");
  });

  it("forwards res.revalidate calls to the Pages runtime", async () => {
    const onRevalidate = vi.fn(async () => {});

    const response = await handlePagesApiRoute({
      match: createMatch(async (_req, res) => {
        await res.revalidate("/posts/one", { unstable_onlyGenerated: true });
        res.json({ revalidated: true });
      }),
      onRevalidate,
      request: new Request("https://example.com/api/revalidate"),
      url: "/api/revalidate",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ revalidated: true });
    expect(onRevalidate).toHaveBeenCalledWith("/posts/one", { unstable_onlyGenerated: true });
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
});
