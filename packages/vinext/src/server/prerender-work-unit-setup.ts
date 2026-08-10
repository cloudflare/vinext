/**
 * Sets up the work unit async storage for prerendering.
 *
 * Wraps every render in Next.js-compatible work-unit state. Build prerenders
 * receive a PrerenderStore; request-time renders receive a RequestStore.
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
  if (workUnitAsyncStorage.getStore() !== undefined) return fn();
  return workUnitAsyncStorage.run({ type: "request" }, fn);
}
