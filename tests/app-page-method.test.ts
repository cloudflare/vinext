import { describe, expect, it } from "vite-plus/test";
import { resolveAppPageMethodResponse } from "../packages/vinext/src/server/app-page-method.js";

describe("app page method policy", () => {
  it("returns 405 with Allow for non-action mutation requests to static candidates", async () => {
    const response = resolveAppPageMethodResponse({
      isStaticEligible: true,
      request: new Request("https://example.com/about", { method: "POST" }),
    });

    if (!response) {
      throw new Error("Expected a Method Not Allowed response");
    }
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    await expect(response.text()).resolves.toBe("Method Not Allowed");
  });

  it("preserves possible server action POSTs", () => {
    const response = resolveAppPageMethodResponse({
      isStaticEligible: true,
      request: new Request("https://example.com/about", {
        headers: { "next-action": "abc123" },
        method: "POST",
      }),
    });

    expect(response).toBeNull();
  });

  it("does not let middleware headers override the 405 Allow header", () => {
    const middlewareHeaders = new Headers({
      Allow: "POST",
      "x-from-middleware": "1",
    });

    const response = resolveAppPageMethodResponse({
      isStaticEligible: true,
      middlewareHeaders,
      request: new Request("https://example.com/about", { method: "PUT" }),
    });

    if (!response) {
      throw new Error("Expected a Method Not Allowed response");
    }
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(response.headers.get("x-from-middleware")).toBe("1");
  });

  it("does not guard pages that are not static or SSG", () => {
    // force-dynamic, revalidate = 0, the edge runtime, and dynamic-segment
    // routes without generateStaticParams all render per request in Next.js.
    expect(
      resolveAppPageMethodResponse({
        isStaticEligible: false,
        request: new Request("https://example.com/dynamic", { method: "PUT" }),
      }),
    ).toBeNull();
  });

  it("passes GET and HEAD through", () => {
    for (const method of ["GET", "HEAD"]) {
      expect(
        resolveAppPageMethodResponse({
          isStaticEligible: true,
          request: new Request("https://example.com/about", { method }),
        }),
      ).toBeNull();
    }
  });
});
