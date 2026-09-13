import { describe, expect, it } from "vite-plus/test";
import {
  createWorkerPrerenderDiscoveryContext,
  createWorkerPrerenderReadinessResponse,
} from "../packages/vinext/src/server/worker-prerender-discovery.js";

describe("Worker prerender path discovery authorization", () => {
  const base = {
    hostRuntime: "worker" as const,
    waitUntil() {},
  };

  it("authorizes only an internal endpoint carrying the current build secret", () => {
    const authorized = createWorkerPrerenderDiscoveryContext(
      base,
      new Request("https://example.com/__vinext/prerender/static-params", {
        headers: { "x-vinext-prerender-secret": "build-secret" },
      }),
      "build-secret",
    );
    const wrongSecret = createWorkerPrerenderDiscoveryContext(
      base,
      new Request("https://example.com/__vinext/prerender/static-params", {
        headers: { "x-vinext-prerender-secret": "wrong" },
      }),
      "build-secret",
    );
    const ordinaryPath = createWorkerPrerenderDiscoveryContext(
      base,
      new Request("https://example.com/cached/intro", {
        headers: { "x-vinext-prerender-secret": "build-secret" },
      }),
      "build-secret",
    );
    const readiness = createWorkerPrerenderDiscoveryContext(
      base,
      new Request("https://example.com/__vinext/prerender/readiness", {
        headers: { "x-vinext-prerender-secret": "build-secret" },
      }),
      "build-secret",
    );

    expect(authorized.isPrerenderPathDiscovery).toBe(true);
    expect(readiness.isPrerenderPathDiscovery).toBe(true);
    expect(wrongSecret).toBe(base);
    expect(ordinaryPath).toBe(base);
  });

  it("answers readiness only after capability and expected-version validation", () => {
    const request = new Request("https://example.com/__vinext/prerender/readiness", {
      headers: {
        "x-vinext-expected-worker-version": "version-a",
        "x-vinext-prerender-secret": "build-secret",
      },
    });
    const authorized = createWorkerPrerenderDiscoveryContext(base, request, "build-secret");
    const response = createWorkerPrerenderReadinessResponse(authorized, request);

    expect(response?.status).toBe(204);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(response?.headers.get("x-vinext-prerender-readiness")).toBe("1");
    const unauthorized = createWorkerPrerenderReadinessResponse(
      base,
      new Request("https://example.com/__vinext/prerender/readiness", {
        headers: { "x-vinext-prerender-secret": "build-secret" },
      }),
    );
    expect(unauthorized?.status).toBe(404);
    expect(unauthorized?.headers.get("cache-control")).toBe("no-store");
  });

  it("accepts POST readiness probes so custom entries do not treat them as public documents", () => {
    const request = new Request("https://example.com/__vinext/prerender/readiness", {
      method: "POST",
      headers: {
        "x-vinext-expected-worker-version": "version-a",
        "x-vinext-prerender-secret": "build-secret",
      },
    });
    const authorized = createWorkerPrerenderDiscoveryContext(base, request, "build-secret");

    expect(createWorkerPrerenderReadinessResponse(authorized, request)?.status).toBe(204);
  });
});
