/**
 * Sets up the work unit async storage for prerendering.
 *
 * Wraps App Router request execution in workUnitAsyncStorage.run().
 *
 * When VINEXT_PRERENDER=1, this uses a PrerenderStore so dynamic APIs (e.g.,
 * io()) can detect the prerender context and return hanging promises. Normal
 * App Router requests use a RequestStore, matching Next.js's internal
 * work-unit async storage shape for components that inspect it directly.
 *
 * Used by: app-rsc-entry.ts handler template.
 *
 */
import { workUnitAsyncStorage } from "vinext/shims/internal/work-unit-async-storage";

export function runWithPrerenderWorkUnit<T>(
  fn: () => Promise<T>,
  options?: { route?: string | (() => string) },
): Promise<T> {
  if (process.env.VINEXT_PRERENDER === "1") {
    const controller = new AbortController();
    const route = typeof options?.route === "function" ? options.route() : options?.route;
    return workUnitAsyncStorage
      .run(
        {
          type: "prerender",
          renderSignal: controller.signal,
          route,
        },
        fn,
      )
      .finally(() => controller.abort());
  }
  return workUnitAsyncStorage.run({ type: "request" }, fn);
}
