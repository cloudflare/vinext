import { afterEach, describe, expect, it } from "vite-plus/test";

import { runWithPrerenderWorkUnit } from "../packages/vinext/src/server/prerender-work-unit-setup.js";
import { workUnitAsyncStorage } from "../packages/vinext/src/shims/internal/work-unit-async-storage.js";

describe("runWithPrerenderWorkUnit", () => {
  const originalPrerenderEnv = process.env.VINEXT_PRERENDER;

  afterEach(() => {
    if (originalPrerenderEnv === undefined) {
      delete process.env.VINEXT_PRERENDER;
    } else {
      process.env.VINEXT_PRERENDER = originalPrerenderEnv;
    }
  });

  it("provides a request work unit during normal App Router requests", async () => {
    delete process.env.VINEXT_PRERENDER;

    const store = await runWithPrerenderWorkUnit(async () => workUnitAsyncStorage.getStore());

    expect(store).toEqual({ type: "request" });
  });

  it("provides a prerender work unit and aborts it after prerender execution", async () => {
    process.env.VINEXT_PRERENDER = "1";

    let renderSignal: AbortSignal | undefined;
    const store = await runWithPrerenderWorkUnit(async () => {
      const activeStore = workUnitAsyncStorage.getStore();
      renderSignal = activeStore?.type === "prerender" ? activeStore.renderSignal : undefined;
      return activeStore;
    });

    expect(store?.type).toBe("prerender");
    expect(renderSignal?.aborted).toBe(true);
  });
});
