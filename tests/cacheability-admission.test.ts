import { describe, expect, it } from "vite-plus/test";
import { captureCacheabilityAdmissionBody } from "../packages/vinext/src/server/cacheability-request.js";

const encoder = new TextEncoder();

describe("cacheability admission capture", () => {
  it("preserves all bytes when the bounded capture limit is exceeded", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("first"));
        controller.enqueue(encoder.encode("second"));
        controller.close();
      },
    });

    const captured = await captureCacheabilityAdmissionBody(body, Date.now() + 1_000, 5);
    expect(captured.kind).toBe("fallback");
    await expect(new Response(captured.body).text()).resolves.toBe("firstsecond");
  });

  it("falls back to the private stream without cancelling a slow response", async () => {
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        controller.enqueue(encoder.encode("slow"));
        controller.close();
      },
    });

    const captured = await captureCacheabilityAdmissionBody(body, Date.now() + 5);
    expect(captured.kind).toBe("fallback");
    await expect(new Response(captured.body).text()).resolves.toBe("slow");
  });
});
