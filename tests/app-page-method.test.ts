import { describe, expect, it } from "vite-plus/test";
import {
  isStaticOrSsgAppPageCandidate,
  resolveAppPageMethodResponse,
} from "../packages/vinext/src/server/app-page-method.js";

describe("app page method policy", () => {
  it("returns 405 with Allow for non-action mutation requests to static candidates", async () => {
    const response = resolveAppPageMethodResponse({
      hasGenerateStaticParams: false,
      isDynamicRoute: false,
      request: new Request("https://example.com/about", { method: "POST" }),
      revalidateSeconds: null,
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
      hasGenerateStaticParams: false,
      isDynamicRoute: false,
      request: new Request("https://example.com/about", {
        headers: { "next-action": "abc123" },
        method: "POST",
      }),
      revalidateSeconds: null,
    });

    expect(response).toBeNull();
  });

  it("does not let middleware headers override the 405 Allow header", () => {
    const middlewareHeaders = new Headers({
      Allow: "POST",
      "x-from-middleware": "1",
    });

    const response = resolveAppPageMethodResponse({
      hasGenerateStaticParams: false,
      isDynamicRoute: false,
      middlewareHeaders,
      request: new Request("https://example.com/about", { method: "PUT" }),
      revalidateSeconds: null,
    });

    if (!response) {
      throw new Error("Expected a Method Not Allowed response");
    }
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(response.headers.get("x-from-middleware")).toBe("1");
  });

  it("treats ISR and generateStaticParams routes as SSG candidates", () => {
    expect(
      isStaticOrSsgAppPageCandidate({
        hasGenerateStaticParams: false,
        isDynamicRoute: false,
        revalidateSeconds: 60,
      }),
    ).toBe(true);

    expect(
      isStaticOrSsgAppPageCandidate({
        hasGenerateStaticParams: true,
        isDynamicRoute: true,
        revalidateSeconds: null,
      }),
    ).toBe(true);
  });

  it("does not guard force-dynamic or revalidate zero pages", () => {
    expect(
      resolveAppPageMethodResponse({
        dynamicConfig: "force-dynamic",
        hasGenerateStaticParams: false,
        isDynamicRoute: false,
        request: new Request("https://example.com/dynamic", { method: "PUT" }),
        revalidateSeconds: null,
      }),
    ).toBeNull();

    expect(
      resolveAppPageMethodResponse({
        hasGenerateStaticParams: false,
        isDynamicRoute: false,
        request: new Request("https://example.com/no-store", { method: "PUT" }),
        revalidateSeconds: 0,
      }),
    ).toBeNull();
  });
});
