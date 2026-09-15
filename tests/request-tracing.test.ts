import { describe, expect, it, vi } from "vite-plus/test";
import {
  attachFrameworkRequestError,
  attachFrameworkRequestRoute,
  captureFrameworkRequestRoute,
  consumeFrameworkRequestRoute,
  setFrameworkRequestRoute,
  traceFrameworkRequest,
} from "../packages/vinext/src/server/request-tracing.js";
import { registerFrameworkTracingIntegration } from "../packages/vinext/src/server/tracer.js";
import type {
  FrameworkTracingBackendSpan,
  ResolvedFrameworkSpanDescriptor,
} from "../packages/vinext/src/server/framework-tracer.js";
import { markFullyBufferedBody } from "../packages/vinext/src/server/fully-buffered-response.js";
import { traceResponseStart } from "../packages/vinext/src/server/response-start-tracing.js";

type RecordedSpan = {
  attributes: Record<string, boolean | number | string>;
  exceptions?: unknown[];
  name: string;
  status?: string;
};

const spans: RecordedSpan[] = [];
const finishedSpans = new Set<RecordedSpan>();
let activeSpan: FrameworkTracingBackendSpan | undefined;
registerFrameworkTracingIntegration({
  getActiveSpan: () => activeSpan,
  id: "request-tracing-test",
  enterSpan<T>(
    descriptor: ResolvedFrameworkSpanDescriptor,
    callback: (span: FrameworkTracingBackendSpan) => T,
  ): T {
    const recorded: RecordedSpan = {
      attributes: { ...descriptor.attributes },
      name: descriptor.name,
    };
    spans.push(recorded);
    const result = callback({
      recordException: (error) => {
        (recorded.exceptions ??= []).push(error);
      },
      setAttribute: (key, value) => {
        recorded.attributes[key] = value;
      },
      setErrorStatus: (message) => {
        recorded.status = message ?? "error";
      },
      updateName: (name) => {
        recorded.name = name;
      },
    });
    if (result instanceof Promise) {
      return result.finally(() => finishedSpans.add(recorded)) as T;
    }
    finishedSpans.add(recorded);
    return result;
  },
});

function traceRequest(callback: () => Promise<Response>): Promise<Response> {
  return traceFrameworkRequest({
    callback,
    getStatus: (response) => response?.status,
    headers: new Headers(),
    method: "get",
    target: "/products/42?view=full",
  });
}

describe("framework request tracing", () => {
  it("keeps the request span open until the response body is consumed", async () => {
    spans.length = 0;
    finishedSpans.clear();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const response = await traceRequest(
      async () =>
        new Response(
          new ReadableStream({
            start(nextController) {
              controller = nextController;
              nextController.enqueue(new TextEncoder().encode("streamed"));
            },
          }),
        ),
    );

    expect(finishedSpans.has(spans[0])).toBe(false);
    const reader = response.body!.getReader();
    await expect(reader.read()).resolves.toMatchObject({ done: false });
    controller.close();
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    await vi.waitFor(() => expect(finishedSpans.has(spans[0])).toBe(true));
  });

  it("keeps a fully buffered request span open until response start is traced", async () => {
    spans.length = 0;
    finishedSpans.clear();
    const response = await traceRequest(async () =>
      traceResponseStart(markFullyBufferedBody(new Response("buffered"))),
    );

    expect(finishedSpans.has(spans[0])).toBe(false);
    await response.text();
    await vi.waitFor(() => expect(finishedSpans.has(spans[0])).toBe(true));
    expect(spans.map(({ attributes }) => attributes["next.span_type"])).toEqual([
      "BaseServer.handleRequest",
      "NextNodeServer.startResponse",
    ]);
  });

  it("finishes the request span when the response body is cancelled", async () => {
    spans.length = 0;
    finishedSpans.clear();
    const response = await traceRequest(
      async () =>
        new Response(
          new ReadableStream({
            pull() {},
          }),
        ),
    );

    expect(finishedSpans.has(spans[0])).toBe(false);
    await response.body!.cancel();
    await vi.waitFor(() => expect(finishedSpans.has(spans[0])).toBe(true));
  });

  it("records a response stream failure on the request span", async () => {
    spans.length = 0;
    finishedSpans.clear();
    const streamError = new Error("response stream failed");
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const response = await traceRequest(
      async () =>
        new Response(
          new ReadableStream({
            start(nextController) {
              controller = nextController;
              nextController.enqueue(new TextEncoder().encode("partial"));
            },
          }),
        ),
    );

    const reader = response.body!.getReader();
    await expect(reader.read()).resolves.toMatchObject({ done: false });
    controller.error(streamError);
    await expect(reader.read()).rejects.toThrow("response stream failed");
    await vi.waitFor(() => expect(finishedSpans.has(spans[0])).toBe(true));
    expect(spans[0]).toMatchObject({
      exceptions: [streamError],
      status: "response stream failed",
    });
  });

  it("finalizes a parameterized RSC route and response status", async () => {
    spans.length = 0;
    const response = await traceRequest(async () => {
      setFrameworkRequestRoute("/products/[id]", true);
      return new Response("ok");
    });

    expect(response.status).toBe(200);
    expect(spans).toEqual([
      {
        attributes: {
          "http.method": "GET",
          "http.route": "/products/[id]",
          "http.status_code": 200,
          "http.target": "/products/42?view=full",
          "next.route": "/products/[id]",
          "next.rsc": true,
          "next.span_category": "nextjs",
          "next.span_name": "RSC GET /products/[id]",
          "next.span_type": "BaseServer.handleRequest",
        },
        name: "RSC GET /products/[id]",
      },
    ]);
  });

  it("keeps the first matched route when rendering a fallback", async () => {
    spans.length = 0;
    await traceRequest(async () => {
      setFrameworkRequestRoute("/products/[id]");
      setFrameworkRequestRoute("/_error");
      return new Response("not found", { status: 404 });
    });

    expect(spans[0]).toMatchObject({
      attributes: {
        "http.route": "/products/[id]",
        "next.route": "/products/[id]",
      },
      name: "GET /products/[id]",
    });
  });

  it("propagates the parameterized route to a pre-existing platform span", async () => {
    const attributes: Record<string, boolean | number | string> = {};
    activeSpan = {
      setAttribute(key, value) {
        attributes[key] = value;
      },
    };

    try {
      await traceRequest(async () => {
        setFrameworkRequestRoute("/products/[id]");
        return new Response("ok");
      });
    } finally {
      activeSpan = undefined;
    }

    expect(attributes).toEqual({ "http.route": "/products/[id]" });
  });

  it("marks 500 responses as failed and does not duplicate nested roots", async () => {
    spans.length = 0;
    await traceRequest(() =>
      traceRequest(async () => {
        setFrameworkRequestRoute("/failure");
        return new Response("failed", { status: 500 });
      }),
    );

    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      attributes: { "error.type": "500", "http.status_code": 500, "next.rsc": false },
      name: "GET /failure",
      status: "error",
    });
  });

  it("keeps one root when a response stage returns the matched route", async () => {
    spans.length = 0;

    await traceRequest(async () => {
      const { result, route } = await captureFrameworkRequestRoute(() =>
        traceRequest(async () => {
          setFrameworkRequestRoute("/products/[id]");
          return new Response("ok");
        }),
      );
      return consumeFrameworkRequestRoute(attachFrameworkRequestRoute(result, route));
    });

    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      attributes: {
        "http.route": "/products/[id]",
        "next.route": "/products/[id]",
      },
      name: "GET /products/[id]",
    });
  });

  it("preserves RSC classification when a response stage returns only the route", async () => {
    spans.length = 0;

    await traceFrameworkRequest({
      callback: async () => {
        const { result, route } = await captureFrameworkRequestRoute(async () => {
          setFrameworkRequestRoute("/products/[id]");
          return new Response("ok");
        });
        return consumeFrameworkRequestRoute(attachFrameworkRequestRoute(result, route));
      },
      getStatus: (response) => response?.status,
      headers: new Headers({ RSC: "1" }),
      isRsc: true,
      method: "GET",
      target: "/products/42.rsc",
    });

    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      attributes: { "next.rsc": true },
      name: "RSC GET /products/[id]",
    });
  });

  it("preserves a WebSocket response while transferring its route", () => {
    const webSocket = {};
    const response = {
      body: null,
      headers: new Headers({ "X-Vinext-Trace-Route": "/user/value" }),
      status: 101,
      statusText: "Switching Protocols",
      webSocket,
    } as unknown as Response;

    const attached = attachFrameworkRequestRoute(response, "/socket/[id]");
    const consumed = consumeFrameworkRequestRoute(attached);

    expect(attached).toBe(response);
    expect(consumed).toBe(response);
    expect(Reflect.get(consumed, "webSocket")).toBe(webSocket);
    expect(consumed.headers.has("X-Vinext-Trace-Route")).toBe(false);
  });

  it("preserves immutable response state while transferring its route", () => {
    const response = Response.redirect("https://example.com/destination", 307);
    const consumed = consumeFrameworkRequestRoute(
      attachFrameworkRequestRoute(response, "/redirect/[slug]"),
    );

    expect(consumed.status).toBe(307);
    expect(consumed.headers.get("location")).toBe("https://example.com/destination");
    expect(consumed.headers.has("X-Vinext-Trace-Route")).toBe(false);
  });

  it("transfers fully buffered response metadata without exposing its internal header", async () => {
    const { isFullyBufferedBody, markFullyBufferedBody } =
      await import("../packages/vinext/src/server/fully-buffered-response.js");
    const attached = attachFrameworkRequestRoute(
      markFullyBufferedBody(new Response("buffered")),
      "/robots.txt",
    );

    expect(attached.headers.get("X-Vinext-Trace-Buffered-Body")).toBe("1");
    const consumed = consumeFrameworkRequestRoute(attached);
    expect(isFullyBufferedBody(consumed)).toBe(true);
    expect(consumed.headers.has("X-Vinext-Trace-Buffered-Body")).toBe(false);
    expect(consumed.headers.has("X-Vinext-Trace-Route")).toBe(false);
  });

  it("records an error returned by a response stage on the owning root", async () => {
    spans.length = 0;
    const failure = new TypeError("route load failed");

    await traceRequest(async () =>
      consumeFrameworkRequestRoute(
        attachFrameworkRequestRoute(
          attachFrameworkRequestError(new Response("failed", { status: 500 }), failure),
          "/broken/[slug]",
        ),
      ),
    );

    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      attributes: {
        "error.type": "500",
        "http.route": "/broken/[slug]",
        "http.status_code": 500,
      },
      exceptions: [expect.objectContaining({ message: "route load failed", name: "TypeError" })],
      name: "GET /broken/[slug]",
      status: "error",
    });
  });

  it("finalizes route and status attributes when request handling rejects", async () => {
    spans.length = 0;
    const status = 200;

    await expect(
      traceFrameworkRequest({
        callback: async () => {
          setFrameworkRequestRoute("/failure/[slug]", true);
          throw new TypeError("request failed");
        },
        getStatus: () => status,
        headers: new Headers(),
        method: "GET",
        target: "/failure/value",
      }),
    ).rejects.toThrow("request failed");

    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      attributes: {
        "error.type": "TypeError",
        "http.route": "/failure/[slug]",
        "http.status_code": 200,
        "next.route": "/failure/[slug]",
        "next.rsc": true,
      },
      name: "RSC GET /failure/[slug]",
      status: "request failed",
    });
  });

  it("shares request state across independently loaded module copies", async () => {
    spans.length = 0;
    const copySpecifier = "../packages/vinext/src/server/request-tracing.js?request-tracing-copy";
    const copiedModule = await import(/* @vite-ignore */ copySpecifier);

    await traceRequest(async () => {
      copiedModule.setFrameworkRequestRoute("/copied/[id]");
      return new Response("ok");
    });

    expect(spans[0]).toMatchObject({
      attributes: {
        "http.route": "/copied/[id]",
        "next.route": "/copied/[id]",
      },
      name: "GET /copied/[id]",
    });
  });

  it("records RSC request state before a route is matched", async () => {
    spans.length = 0;

    await traceFrameworkRequest({
      callback: async () => new Response("missing", { status: 404 }),
      getStatus: (response) => response?.status,
      headers: new Headers({ RSC: "1" }),
      isRsc: true,
      method: "GET",
      target: "/missing.rsc",
    });

    expect(spans[0]).toMatchObject({
      attributes: { "http.status_code": 404, "next.rsc": true },
      name: "RSC GET",
    });
  });
});
