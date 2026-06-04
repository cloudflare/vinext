import { describe, expect, it } from "vite-plus/test";
import {
  createAppLayoutParamAccessTracker,
  getStaticLayoutObservationSkipRejection,
  isAppLayoutObservationUnsafeForStaticReuse,
  type AppLayoutParamAccessObservation,
} from "../packages/vinext/src/server/app-layout-param-observation.js";
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
import {
  markDynamicUsage,
  markRenderRequestApiUsage,
} from "../packages/vinext/src/shims/headers.js";

function createObservation(
  overrides: Partial<AppLayoutParamAccessObservation> = {},
): AppLayoutParamAccessObservation {
  return {
    cacheLifeObserved: false,
    cacheTags: [],
    cacheableFetchCount: 0,
    completeness: "complete",
    dynamicFetchCount: 0,
    dynamicUsageObserved: false,
    finiteRevalidateSeconds: null,
    keys: [],
    observed: false,
    paramScopeKeys: [],
    requestApis: [],
    unstableCaches: [],
    ...overrides,
  };
}

describe("app layout param observation", () => {
  it("folds a probe-scoped markDynamicUsage() into the observation as unsafe for static reuse", () => {
    // Regression guard: the probe runs inside an isolated child scope that
    // resets `dynamicUsageDetected`, so a `markDynamicUsage()` with no other
    // observable trace (e.g. `"use cache: private"`) would be discarded when
    // the scope exits — masking the Layer-3 `dynamicDetected` signal. The
    // tracker must capture it so the two signals can't diverge.
    const tracker = createAppLayoutParamAccessTracker();

    void runWithRequestContext(createRequestContext(), () => {
      tracker.runLayoutProbe("layout:/dynamic", () => {
        // No request API, cache tag, fetch, or param access — only the raw
        // dynamic-usage flag, which is the path the old code caught via
        // `consumeDynamicUsage()`.
        markDynamicUsage();
      });
      tracker.runLayoutProbe("layout:/static", () => null);
    });

    const dynamicObservation = tracker.getLayoutObservation("layout:/dynamic");
    expect(dynamicObservation.dynamicUsageObserved).toBe(true);
    expect(isAppLayoutObservationUnsafeForStaticReuse(dynamicObservation)).toBe(true);

    const staticObservation = tracker.getLayoutObservation("layout:/static");
    expect(staticObservation.dynamicUsageObserved).toBe(false);
    expect(isAppLayoutObservationUnsafeForStaticReuse(staticObservation)).toBe(false);
  });

  it("returns a distinct skip rejection for each unsafe observation shape", () => {
    const unsafeCases = [
      {
        code: "SKIP_LAYOUT_PARAMS_OBSERVATION_INCOMPLETE",
        name: "incomplete probe",
        observation: createObservation({ completeness: "unknown" }),
      },
      {
        code: "SKIP_LAYOUT_PARAMS_PRESENT",
        name: "param scope keys",
        observation: createObservation({ paramScopeKeys: ["slug"] }),
      },
      {
        code: "SKIP_LAYOUT_PARAMS_OBSERVED",
        name: "observed params",
        observation: createObservation({ keys: ["slug"], observed: true }),
      },
      {
        code: "SKIP_LAYOUT_DYNAMIC_USAGE_OBSERVED",
        name: "dynamic usage",
        observation: createObservation({ dynamicUsageObserved: true }),
      },
      {
        code: "SKIP_LAYOUT_REQUEST_API_OBSERVED",
        name: "request APIs",
        observation: createObservation({ requestApis: ["headers"] }),
      },
      {
        code: "SKIP_LAYOUT_REVALIDATE_PRESENT",
        name: "finite revalidate",
        observation: createObservation({ finiteRevalidateSeconds: 60 }),
      },
      {
        code: "SKIP_LAYOUT_CACHE_LIFE_OBSERVED",
        name: "cacheLife",
        observation: createObservation({ cacheLifeObserved: true }),
      },
      {
        code: "SKIP_LAYOUT_UNSTABLE_CACHE_OBSERVED",
        name: "unstable_cache",
        observation: createObservation({
          unstableCaches: [
            {
              keyHash: "abc123",
              kind: "unstable_cache",
              revalidate: 60,
              tagCount: 1,
              tagHash: "tag123",
            },
          ],
        }),
      },
      {
        code: "SKIP_LAYOUT_CACHE_TAGS_OBSERVED",
        name: "cache tags",
        observation: createObservation({ cacheTags: ["tag:dashboard"] }),
      },
      {
        code: "SKIP_LAYOUT_CACHEABLE_FETCHES_OBSERVED",
        name: "cacheable fetches",
        observation: createObservation({ cacheableFetchCount: 1 }),
      },
      {
        code: "SKIP_LAYOUT_DYNAMIC_FETCHES_OBSERVED",
        name: "dynamic fetches",
        observation: createObservation({ dynamicFetchCount: 1 }),
      },
    ] as const;

    for (const testCase of unsafeCases) {
      const rejection = getStaticLayoutObservationSkipRejection(testCase.observation);
      expect(rejection?.code, testCase.name).toBe(testCase.code);
      expect(rejection?.fields.dynamicUsageObserved, testCase.name).toBe(
        testCase.observation.dynamicUsageObserved,
      );
    }

    const safeObservation = createObservation();
    expect(getStaticLayoutObservationSkipRejection(safeObservation)).toBeNull();
    expect(isAppLayoutObservationUnsafeForStaticReuse(safeObservation)).toBe(false);
  });

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
