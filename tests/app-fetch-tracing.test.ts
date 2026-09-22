import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  createAppFetchSpanDescriptor,
  traceAppFetch,
} from "../packages/vinext/src/server/app-fetch-tracing.js";
import { registerFrameworkTracingIntegration } from "../packages/vinext/src/server/tracer.js";

describe("App fetch tracing", () => {
  // Ported from Next.js: packages/next/src/server/lib/patch-fetch.ts
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/lib/patch-fetch.ts
  it("matches the stable Next.js fetch span descriptor", () => {
    expect(
      createAppFetchSpanDescriptor("https://user:secret@example.com:8443/products", {
        method: "post",
      }),
    ).toEqual({
      attributes: {
        "http.method": "POST",
        "http.url": "https://example.com:8443/products",
        "net.peer.name": "example.com",
        "net.peer.port": "8443",
      },
      kind: "client",
      name: "fetch POST https://example.com:8443/products",
      type: "AppRender.fetch",
    });
  });

  it("lets native fetch report malformed URLs", () => {
    expect(createAppFetchSpanDescriptor("not a URL")).toMatchObject({
      attributes: { "http.method": "GET", "http.url": "" },
      name: "fetch GET",
    });
  });

  it("honors NEXT_OTEL_FETCH_DISABLED", async () => {
    let entered = false;
    registerFrameworkTracingIntegration({
      id: "app-fetch-disabled-test",
      enterSpan(_descriptor, callback) {
        entered = true;
        return callback({ setAttribute() {} });
      },
    });
    process.env.NEXT_OTEL_FETCH_DISABLED = "1";

    const response = await traceAppFetch(
      "https://example.com/",
      undefined,
      async () => new Response("ok", { status: 200 }),
    );

    expect(response.status).toBe(200);
    expect(entered).toBe(false);
  });
});

afterEach(() => {
  delete process.env.NEXT_OTEL_FETCH_DISABLED;
});
