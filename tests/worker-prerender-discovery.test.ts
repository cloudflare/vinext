import { describe, expect, it } from "vite-plus/test";
import { createWorkerPrerenderDiscoveryContext } from "../packages/vinext/src/server/worker-prerender-discovery.js";

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
    const validation = createWorkerPrerenderDiscoveryContext(
      base,
      new Request("https://example.com/__vinext/prerender/validate-app-routes", {
        headers: { "x-vinext-prerender-secret": "build-secret" },
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

    expect(authorized.isPrerenderPathDiscovery).toBe(true);
    expect(validation.isPrerenderPathDiscovery).toBe(true);
    expect(wrongSecret).toBe(base);
    expect(ordinaryPath).toBe(base);
  });
});
