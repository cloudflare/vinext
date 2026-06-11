import { AsyncLocalStorage } from "node:async_hooks";
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
    // forget to call res.end() must not hang the request. Only returning
    // the response writable itself (from req.pipe(...).pipe(res)) should
    // defer auto-ending.
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

  it("streams multi-chunk res.write() / res.end() through a ReadableStream body", async () => {
    const response = await handlePagesApiRoute({
      match: createMatch((_req, res) => {
        res.write("chunk-1");
        res.write("chunk-2");
        res.write("chunk-3");
        res.end();
      }),
      request: new Request("https://example.com/api/multi-chunk"),
      url: "/api/multi-chunk",
    });

    expect(response.status).toBe(200);
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
});
