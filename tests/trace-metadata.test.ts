import { describe, expect, it } from "vite-plus/test";
import {
  getClientTraceMetadataHtml,
  injectHtmlBeforeHeadClose,
} from "../packages/vinext/src/server/trace-metadata.js";

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

describe("client trace metadata", () => {
  it("filters OpenTelemetry propagation entries by clientTraceMetadata", async () => {
    // Ported from Next.js: test/e2e/opentelemetry/client-trace-metadata/client-trace-metadata.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/opentelemetry/client-trace-metadata/client-trace-metadata.test.ts
    const html = await getClientTraceMetadataHtml(
      ["my-parent-span-id", "my-test-key-1", "my-test-key-2"],
      async () => ({
        context: {
          active: () => ({}),
          with: (_context, fn) => fn(),
        },
        propagation: {
          inject(_context, carrier, setter) {
            const textMapSetter = setter as {
              set(carrier: Array<{ key: string; value: string }>, key: string, value: string): void;
            };
            textMapSetter.set(carrier, "my-test-key-1", "my-test-value-1");
            textMapSetter.set(carrier, "my-test-key-2", "my-test-value-2");
            textMapSetter.set(carrier, "non-metadata-key-3", "non-metadata-key-3");
            textMapSetter.set(carrier, "my-parent-span-id", "0123456789abcdef");
          },
        },
        trace: {
          setSpan: (context) => context,
          wrapSpanContext: (context) => context,
        },
      }),
    );

    expect(html).toContain('<meta name="my-test-key-1" content="my-test-value-1">');
    expect(html).toContain('<meta name="my-test-key-2" content="my-test-value-2">');
    expect(html).toContain('<meta name="my-parent-span-id" content="0123456789abcdef">');
    expect(html).not.toContain("non-metadata-key-3");
  });

  it("injects trace metadata before the head closes", async () => {
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("<html><head><title>x</title>"));
        controller.enqueue(new TextEncoder().encode("</head><body>ok</body></html>"));
        controller.close();
      },
    });

    await expect(
      readStream(injectHtmlBeforeHeadClose(input, '<meta name="x" content="y">')),
    ).resolves.toBe(
      '<html><head><title>x</title><meta name="x" content="y"></head><body>ok</body></html>',
    );
  });
});
