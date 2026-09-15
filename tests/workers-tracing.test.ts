import { describe, expect, it } from "vite-plus/test";
import { createFrameworkTracer } from "../packages/vinext/src/server/framework-tracer.js";
import {
  createWorkersTracingIntegration,
  type WorkersTracingException,
  type WorkersTracingSpan,
} from "../packages/vinext/src/server/workers-tracing.js";

// Cloudflare Workers custom spans API:
// https://developers.cloudflare.com/workers/observability/traces/custom-spans/

type RecordedSpan = {
  attributes: Record<string, boolean | number | string>;
  exceptions: WorkersTracingException[];
  name: string;
};

function fakeTracing(spans: RecordedSpan[], isTraced = true) {
  return {
    enterSpan<T>(name: string, callback: (span: WorkersTracingSpan) => T): T {
      const recorded: RecordedSpan = { attributes: {}, exceptions: [], name };
      spans.push(recorded);
      return callback({
        isTraced,
        recordException: (exception) => recorded.exceptions.push(exception),
        setAttribute: (key, value) => {
          recorded.attributes[key] = value;
        },
      });
    },
  };
}

describe("Workers framework tracing integration", () => {
  it("emits the shared Next.js descriptor and runs the callback once", async () => {
    const spans: RecordedSpan[] = [];
    const tracer = createFrameworkTracer([createWorkersTracingIntegration(fakeTracing(spans))]);
    let calls = 0;

    await expect(
      tracer.trace(
        {
          attributes: { "next.route": "/products/[id]", "next.rsc": true },
          name: "GET /products/[id]",
          type: "BaseServer.handleRequest",
        },
        async (span) => {
          calls++;
          span.setAttribute("http.status_code", 200);
          span.updateName("RSC GET /products/[id]");
          return "ok";
        },
      ),
    ).resolves.toBe("ok");

    expect(calls).toBe(1);
    expect(spans).toEqual([
      {
        attributes: {
          "http.status_code": 200,
          "next.route": "/products/[id]",
          "next.rsc": true,
          "next.span_category": "nextjs",
          "next.span_name": "RSC GET /products/[id]",
          "next.span_type": "BaseServer.handleRequest",
        },
        exceptions: [],
        name: "GET /products/[id]",
      },
    ]);
  });

  it("records failures and still executes work when the native span is not sampled", async () => {
    const spans: RecordedSpan[] = [];
    const tracer = createFrameworkTracer([
      createWorkersTracingIntegration(fakeTracing(spans, false)),
    ]);
    const failure = new TypeError("broken");
    let calls = 0;

    await expect(
      tracer.trace({ type: "AppRender.getBodyResult" }, async () => {
        calls++;
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(calls).toBe(1);
    expect(spans[0]?.attributes["error.type"]).toBe("TypeError");
    expect(spans[0]?.exceptions).toEqual([
      expect.objectContaining({ message: "broken", name: "TypeError" }),
    ]);
  });

  it("loads the Node tracer without evaluating cloudflare:workers", async () => {
    await expect(import("../packages/vinext/src/server/tracer.js")).resolves.toHaveProperty(
      "frameworkTracer",
    );
  });
});
