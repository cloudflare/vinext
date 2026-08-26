/**
 * Sets up the work unit async storage for prerendering.
 *
 * During build prerendering and authenticated cacheability probes, wraps
 * execution in a PrerenderStore so dynamic APIs can suspend and the render
 * owner can interrupt the attempt without exposing catchable framework errors
 * to user code.
 *
 * Used by: app-rsc-entry.ts handler template.
 *
 * TODO: If future dynamic APIs need request-scoped stores for normal (non-prerender)
 * requests, add a `{ type: "request" }` store during normal request handling.
 */
import { workUnitAsyncStorage } from "vinext/shims/internal/work-unit-async-storage";
import { isRouteCacheabilityProbe } from "vinext/shims/cacheability-classification";
import { NO_STORE_CACHE_CONTROL } from "./cache-control.js";

export function runWithPrerenderWorkUnit(
  fn: () => Promise<Response>,
  options?: { cacheComponents?: boolean; route?: string | (() => string) },
): Promise<Response> {
  if (process.env.VINEXT_PRERENDER === "1" || isRouteCacheabilityProbe()) {
    if (options?.cacheComponents !== true) {
      return workUnitAsyncStorage.run({ type: "prerender-legacy" }, fn);
    }
    return runWithPrerenderWorkUnitOwner(fn, options);
  }
  return fn();
}

async function runWithPrerenderWorkUnitOwner(
  fn: () => Promise<Response>,
  options?: { route?: string | (() => string) },
): Promise<Response> {
  const controller = new AbortController();
  const route = typeof options?.route === "function" ? options.route() : options?.route;
  let signalBailout!: (expression: string) => void;
  const bailout = new Promise<{ kind: "bailout" }>((resolve) => {
    signalBailout = () => resolve({ kind: "bailout" });
  });
  const render = workUnitAsyncStorage.run(
    {
      type: "prerender",
      renderSignal: controller.signal,
      route,
      signalPrerenderBailout: signalBailout,
    },
    fn,
  );
  try {
    const result = await Promise.race([
      render.then((response) => ({ kind: "response" as const, response })),
      bailout,
    ]);
    if (result.kind === "response") {
      return result.response;
    }

    // The suspended render is deliberately abandoned. It must remain pending
    // so user try/catch blocks cannot execute a probe-only fallback. If another
    // renderer branch happens to settle, dispose its body without extending
    // the request lifetime.
    void render.then((response) => response.body?.cancel()).catch(() => {});
    return new Response(null, {
      headers: { "Cache-Control": NO_STORE_CACHE_CONTROL },
    });
  } finally {
    controller.abort();
  }
}
