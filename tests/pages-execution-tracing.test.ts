import { describe, expect, it } from "vite-plus/test";
import {
  createPagesApiHandlerSpanDescriptor,
  createPagesDataSpanDescriptor,
  createPagesDocumentSpanDescriptor,
  createPagesFindPageComponentsSpanDescriptor,
  tracePagesDocumentStream,
} from "../packages/vinext/src/server/pages-execution-tracing.js";
import { registerFrameworkTracingIntegration } from "../packages/vinext/src/server/tracer.js";

let captureLifecycle = false;
const lifecycleEvents: string[] = [];
registerFrameworkTracingIntegration({
  id: "pages-document-lifecycle-test",
  enterSpan(descriptor, callback) {
    if (!captureLifecycle || descriptor.type !== "Render.renderDocument") {
      return callback({ setAttribute() {} });
    }
    lifecycleEvents.push("start");
    const result = callback({
      recordException(error) {
        lifecycleEvents.push(`error:${error instanceof Error ? error.message : String(error)}`);
      },
      setAttribute() {},
      setErrorStatus() {},
    });
    return Promise.resolve(result).finally(() => lifecycleEvents.push("end")) as typeof result;
  },
});

describe("Pages execution tracing", () => {
  // Ported from Next.js: test/e2e/opentelemetry/instrumentation/opentelemetry.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/opentelemetry/instrumentation/opentelemetry.test.ts
  it.each([
    ["getServerSideProps", "Render.getServerSideProps"],
    ["getStaticProps", "Render.getStaticProps"],
  ] as const)("matches the stable Next.js %s span descriptor", (method, type) => {
    expect(createPagesDataSpanDescriptor(method, "/products/:slug")).toEqual({
      attributes: { "next.route": "/products/[slug]" },
      name: `${method} /products/[slug]`,
      type,
    });
  });

  it("matches the stable Next.js Pages API handler span descriptor", () => {
    expect(createPagesApiHandlerSpanDescriptor("/api/products/:slug")).toEqual({
      name: "executing api route (pages) /api/products/[slug]",
      type: "Node.runHandler",
    });
  });

  it("matches the stable Next.js Pages document span descriptor", () => {
    expect(createPagesDocumentSpanDescriptor("/products/:slug")).toEqual({
      attributes: { "next.route": "/products/[slug]" },
      name: "render route (pages) /products/[slug]",
      type: "Render.renderDocument",
    });
  });

  it("matches the stable Next.js page component resolution span descriptor", () => {
    expect(createPagesFindPageComponentsSpanDescriptor("/products/:slug")).toEqual({
      attributes: { "next.route": "/products/[slug]" },
      name: "resolve page components",
      type: "NextNodeServer.findPageComponents",
    });
  });

  it("keeps streamed document spans open until delayed body rendering completes", async () => {
    lifecycleEvents.length = 0;
    captureLifecycle = true;
    let close!: () => void;
    try {
      const traced = await tracePagesDocumentStream("/streamed", async () => ({
        bodyStream: new ReadableStream<Uint8Array>({
          start(controller) {
            close = () => controller.close();
          },
        }),
        waitForBody: true,
      }));

      expect(lifecycleEvents).toEqual(["start"]);
      const consumed = new Response(traced.bodyStream).text();
      await Promise.resolve();
      expect(lifecycleEvents).toEqual(["start"]);
      close();
      await consumed;
      await expect.poll(() => lifecycleEvents).toEqual(["start", "end"]);
    } finally {
      captureLifecycle = false;
    }
  });

  it("records late document stream failures before ending the span", async () => {
    lifecycleEvents.length = 0;
    captureLifecycle = true;
    try {
      const traced = await tracePagesDocumentStream("/stream-error", async () => ({
        bodyStream: new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.error(new Error("late render failure"));
          },
        }),
        waitForBody: true,
      }));

      await expect(new Response(traced.bodyStream).text()).rejects.toThrow("late render failure");
      await expect
        .poll(() => lifecycleEvents)
        .toEqual(["start", "error:late render failure", "end"]);
    } finally {
      captureLifecycle = false;
    }
  });
});
