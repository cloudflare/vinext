/**
 * Sets up the work unit async storage for prerendering.
 *
 * When VINEXT_PRERENDER=1, wraps execution in a workUnitAsyncStorage.run()
 * with a PrerenderStore so that dynamic APIs (e.g., unstable_io()) can
 * detect the prerender context and return hanging promises.
 *
 * Used by: app-rsc-entry.ts handler template.
 *
 * TODO: If future dynamic APIs need request-scoped stores for normal (non-prerender)
 * requests, add a `{ type: "request" }` store during normal request handling.
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
  return fn();
}
