import { afterEach, expect, it } from "vite-plus/test";
import {
  beginRouteCacheability,
  createWorkerCacheabilityContext,
} from "../packages/vinext/src/server/cacheability-request.js";
import { makeCacheabilityAwarePageParams } from "../packages/vinext/src/server/cacheability-route-params.js";
import { consumeDynamicUsage } from "../packages/vinext/src/shims/headers.js";
import { runWithExecutionContext } from "../packages/vinext/src/shims/request-context.js";

afterEach(() => {
  consumeDynamicUsage();
});

it("treats unknown Cache Components params as runtime data without a CDN manifest", () => {
  consumeDynamicUsage();
  const params = makeCacheabilityAwarePageParams({ slug: "unknown" }, true, true);

  expect(params.slug).toBe("unknown");
  expect(consumeDynamicUsage()).toBe(true);
});

it("keeps generated and non-Cache-Components params static", () => {
  consumeDynamicUsage();
  expect(makeCacheabilityAwarePageParams({ slug: "known" }, true, false).slug).toBe("known");
  expect(makeCacheabilityAwarePageParams({ slug: "fallback" }, false, true).slug).toBe("fallback");
  expect(consumeDynamicUsage()).toBe(false);
});

it("lets a staged probe observe generated params before the final manifest exists", async () => {
  const request = new Request("https://example.com/products/known", {
    headers: {
      "X-Vinext-Cacheability-Probe": "1",
      "X-Vinext-Prerender-Secret": "secret-a",
    },
  });
  const context = createWorkerCacheabilityContext(
    { hostRuntime: "worker", isCloudflareWorker: true, waitUntil() {} },
    request,
    "secret-a",
  );

  await runWithExecutionContext(context, async () => {
    consumeDynamicUsage();
    expect(beginRouteCacheability("app-page", "/products/:slug")).toBe(true);
    expect(makeCacheabilityAwarePageParams({ slug: "known" }, true, true).slug).toBe("known");
    expect(consumeDynamicUsage()).toBe(false);
  });
});
