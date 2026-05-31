import { describe, expect, it } from "vite-plus/test";
import { createAppLayoutParamAccessTracker } from "../packages/vinext/src/server/app-layout-param-observation.js";
import {
  cacheLife,
  MemoryCacheHandler,
  setCacheHandler,
  unstable_cache,
} from "../packages/vinext/src/shims/cache.js";
import { ensureFetchPatch } from "../packages/vinext/src/shims/fetch-cache.js";
import {
  createRequestContext,
  getRequestContext,
  runWithRequestContext,
} from "../packages/vinext/src/shims/unified-request-context.js";
import { markRenderRequestApiUsage } from "../packages/vinext/src/shims/headers.js";

describe("app layout param observation", () => {
  it("isolates fetch and cacheLife observations to the current layout probe", async () => {
    const tracker = createAppLayoutParamAccessTracker();

    await runWithRequestContext(createRequestContext(), async () => {
      await tracker.runLayoutProbe("layout:/dashboard/settings", () => {
        const ctx = getRequestContext();
        ctx.currentRequestTags.push("shared-tag");
        ctx.cacheableFetchUrls.add("https://example.com/settings");
        ctx.dynamicFetchUrls.add("https://example.com/settings-dynamic");
        cacheLife("seconds");
        markRenderRequestApiUsage("headers");
      });

      await tracker.runLayoutProbe("layout:/dashboard", () => null);

      await tracker.runLayoutProbe("layout:/dashboard/profile", () => {
        const ctx = getRequestContext();
        ctx.currentRequestTags.push("shared-tag");
        ctx.cacheableFetchUrls.add("https://example.com/profile");
        markRenderRequestApiUsage("cookies");
      });
    });

    expect(tracker.getLayoutObservation("layout:/dashboard/settings")).toMatchObject({
      cacheLifeObserved: true,
      cacheTags: ["shared-tag"],
      cacheableFetchCount: 1,
      dynamicFetchCount: 1,
      requestApis: ["headers"],
    });
    expect(tracker.getLayoutObservation("layout:/dashboard")).toMatchObject({
      cacheLifeObserved: false,
      cacheTags: [],
      cacheableFetchCount: 0,
      dynamicFetchCount: 0,
      requestApis: [],
    });
    expect(tracker.getLayoutObservation("layout:/dashboard/profile")).toMatchObject({
      cacheLifeObserved: false,
      cacheTags: ["shared-tag"],
      cacheableFetchCount: 1,
      dynamicFetchCount: 0,
      requestApis: ["cookies"],
    });
  });

  it("records unstable_cache dependencies on cache miss and hit", async () => {
    setCacheHandler(new MemoryCacheHandler());
    const tracker = createAppLayoutParamAccessTracker();
    let calls = 0;
    const cached = unstable_cache(
      async () => {
        calls += 1;
        return `banner-${calls}`;
      },
      ["layout-banner"],
      { tags: ["banner"], revalidate: 60 },
    );

    await runWithRequestContext(createRequestContext(), async () => {
      await tracker.runLayoutProbe("layout:/miss", () => cached());
      await tracker.runLayoutProbe("layout:/hit", () => cached());
    });

    expect(calls).toBe(1);
    expect(tracker.getLayoutObservation("layout:/miss")).toMatchObject({
      unstableCaches: [
        {
          kind: "unstable_cache",
          revalidate: 60,
          tagCount: 1,
        },
      ],
    });
    expect(tracker.getLayoutObservation("layout:/hit")).toMatchObject({
      unstableCaches: [
        {
          kind: "unstable_cache",
          revalidate: 60,
          tagCount: 1,
        },
      ],
    });
  });

  it("observes cacheable fetch dependencies synchronously, before the fetch settles", () => {
    ensureFetchPatch();
    setCacheHandler(new MemoryCacheHandler());

    const tracker = createAppLayoutParamAccessTracker();

    // runLayoutProbe runs the probe synchronously, snapshots
    // observations, and marks the probe complete — all before the
    // fetch promise settles. If the cacheable-fetch observation is
    // deferred past await buildFetchCacheKey(), this assertion fails
    // because the probe will have already snapshotted.
    void runWithRequestContext(createRequestContext(), () => {
      // Use runLayoutProbe synchronously (probe returns non-promise)
      // so the sync path executes recordProbeDependencies immediately.
      tracker.runLayoutProbe("layout:/banner", () => {
        // Do not await the fetch — it must still be observable.
        // Catch the background promise so it cannot produce an
        // unhandled rejection after the synchronous assertions
        // complete. The patched fetch continues past observation
        // into cache lookup and network fetch, which may fail in
        // this test environment.
        fetch("https://example.com/data", {
          next: { revalidate: 60, tags: ["banner"] },
        }).catch(() => {});
      });
    });

    // The observation must already include the cacheable fetch
    // dependency, because recordCacheableFetchObservation runs
    // synchronously before any await in the patched fetch branch.
    expect(tracker.getLayoutObservation("layout:/banner")).toMatchObject({
      cacheableFetchCount: 1,
      cacheTags: ["banner"],
      completeness: "complete",
    });
  });
});
