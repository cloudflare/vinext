import { describe, expect, it } from "vite-plus/test";
import {
  createResponseStartSpanDescriptor,
  traceCachedResponseStart,
  traceResponseStart,
  traceResponseStartWithCompletion,
} from "../packages/vinext/src/server/response-start-tracing.js";
import {
  frameworkTracer,
  registerFrameworkTracingIntegration,
} from "../packages/vinext/src/server/tracer.js";
import type {
  FrameworkTracingBackendSpan,
  ResolvedFrameworkSpanDescriptor,
} from "../packages/vinext/src/server/framework-tracer.js";
import {
  isFullyBufferedBody,
  markFullyBufferedBody,
} from "../packages/vinext/src/server/fully-buffered-response.js";
import {
  hasPostConfigLinkHeaders,
  markEdgeRouteHandlerLinkHeaders,
} from "../packages/vinext/src/server/app-response-header-provenance.js";

type RecordedSpan = ResolvedFrameworkSpanDescriptor & { parentType?: string };

let activeSpan: string | undefined;
const recordedSpans: RecordedSpan[] = [];
registerFrameworkTracingIntegration({
  id: "response-start-tracing-test",
  captureActiveContext() {
    const captured = activeSpan;
    return <T>(callback: () => T): T => {
      const previous = activeSpan;
      activeSpan = captured;
      try {
        return callback();
      } finally {
        activeSpan = previous;
      }
    };
  },
  enterSpan<T>(
    descriptor: ResolvedFrameworkSpanDescriptor,
    callback: (span: FrameworkTracingBackendSpan) => T,
  ): T {
    recordedSpans.push({ ...descriptor, parentType: activeSpan });
    const previous = activeSpan;
    activeSpan = descriptor.type;
    try {
      return callback({ setAttribute() {} });
    } finally {
      activeSpan = previous;
    }
  },
});

describe("response start tracing", () => {
  // Ported from Next.js: test/e2e/opentelemetry/instrumentation/opentelemetry.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/opentelemetry/instrumentation/opentelemetry.test.ts
  it("matches the Next.js descriptor", () => {
    expect(createResponseStartSpanDescriptor()).toEqual({
      name: "start response",
      type: "NextNodeServer.startResponse",
    });
  });

  it("emits one child span when the first response chunk is read", async () => {
    recordedSpans.length = 0;
    const traced = frameworkTracer.trace({ name: "render", type: "AppRender.getBodyResult" }, () =>
      traceResponseStartWithCompletion(new Response("two chunks")),
    );
    const response = traceResponseStart(traced.response);
    const reader = response.body!.getReader();
    let startSettled = false;
    void traced.started.then(() => {
      startSettled = true;
    });

    expect(recordedSpans.map(({ type }) => type)).toEqual(["AppRender.getBodyResult"]);
    expect(response).toBe(traced.response);
    expect(startSettled).toBe(false);
    expect((await reader.read()).done).toBe(false);
    await traced.started;
    expect(startSettled).toBe(true);
    expect((await reader.read()).done).toBe(true);

    expect(recordedSpans).toContainEqual(
      expect.objectContaining({
        attributes: expect.objectContaining({
          "next.span_name": "start response",
          "next.span_type": "NextNodeServer.startResponse",
        }),
        name: "start response",
        parentType: "AppRender.getBodyResult",
        type: "NextNodeServer.startResponse",
      }),
    );
    expect(
      recordedSpans.filter(({ type }) => type === "NextNodeServer.startResponse"),
    ).toHaveLength(1);
  });

  it("does not emit a span for an empty response body", async () => {
    recordedSpans.length = 0;
    const response = traceResponseStart(new Response(new Uint8Array()));

    await response.arrayBuffer();

    expect(recordedSpans).toEqual([]);
  });

  it("starts on the first written chunk even when it is zero length", async () => {
    recordedSpans.length = 0;
    const response = traceResponseStart(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array());
            controller.enqueue(new TextEncoder().encode("body"));
            controller.close();
          },
        }),
      ),
    );
    const reader = response.body!.getReader();

    expect((await reader.read()).value).toHaveLength(0);
    expect(recordedSpans).toContainEqual(
      expect.objectContaining({ type: "NextNodeServer.startResponse" }),
    );
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("body");
  });

  it.each(["HIT", "STALE", "REVALIDATED", "UPDATING"])(
    "traces a response-stage cache %s beneath the active request",
    async (cacheStatus) => {
      recordedSpans.length = 0;
      const response = frameworkTracer.trace(
        { name: "GET", type: "BaseServer.handleRequest" },
        () =>
          traceCachedResponseStart(new Response("cached"), cacheStatus, {
            kind: "app-page",
            isRscRequest: false,
          }),
      );

      await response.text();

      expect(recordedSpans.map(({ type, parentType }) => ({ type, parentType }))).toEqual([
        { type: "BaseServer.handleRequest", parentType: undefined },
        { type: "NextNodeServer.startResponse", parentType: "BaseServer.handleRequest" },
      ]);
    },
  );

  it.each(["MISS", "BYPASS", "EXPIRED", null])(
    "leaves a newly rendered response-stage %s response alone",
    async (cacheStatus) => {
      recordedSpans.length = 0;
      const original = new Response("rendered");
      const response = traceCachedResponseStart(original, cacheStatus, {
        kind: "app-page",
        isRscRequest: false,
      });

      await response.text();

      expect(response).toBe(original);
      expect(recordedSpans).toEqual([]);
    },
  );

  it.each([
    { kind: "app-page", isRscRequest: true },
    { kind: "app-metadata", isRscRequest: false },
    { kind: "hybrid-pages", isRscRequest: false },
  ])("does not trace a cached $kind response with RSC=$isRscRequest", async (props) => {
    recordedSpans.length = 0;
    const original = new Response("cached");
    const response = traceCachedResponseStart(original, "HIT", props);

    await response.text();

    expect(response).toBe(original);
    expect(recordedSpans).toEqual([]);
  });

  it("preserves response metadata while replacing the body", () => {
    const response = markFullyBufferedBody(
      new Response("body", { headers: { Link: "</route.css>; rel=preload" } }),
    );
    markEdgeRouteHandlerLinkHeaders(response.headers, response.headers.get("link"));

    const traced = traceResponseStart(response);

    expect(isFullyBufferedBody(traced)).toBe(true);
    expect(hasPostConfigLinkHeaders(traced.headers)).toBe(true);
  });
});
