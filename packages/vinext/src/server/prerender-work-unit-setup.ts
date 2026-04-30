/**
 * Sets up the work unit async storage for prerendering.
 *
 * When VINEXT_PRERENDER=1, wraps execution in a workUnitAsyncStorage.run()
 * with a PrerenderStore so that dynamic APIs (e.g., unstable_io()) can
 * detect the prerender context and return hanging promises.
 *
 * Used by: app-rsc-entry.ts handler template.
 */
import { workUnitAsyncStorage } from "../shims/internal/work-unit-async-storage.js";

export function runWithPrerenderWorkUnit<T>(fn: () => Promise<T>): Promise<T> {
  if (process.env.VINEXT_PRERENDER === "1") {
    const controller = new AbortController();
    return workUnitAsyncStorage.run(
      {
        type: "prerender",
        renderSignal: controller.signal,
      },
      fn,
    );
  }
  return fn();
}
