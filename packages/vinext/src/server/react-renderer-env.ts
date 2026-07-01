export type ReactNodeEnv = "development" | "production";

type ReactDomServerEdge = typeof import("react-dom/server.edge");

/**
 * Detect whether the *already-loaded* React runtime is a development or
 * production build by inspecting `createElement`'s source: dev builds carry
 * owner-tracking (`getOwner`) that production builds strip. This is the source
 * of truth for which `react-dom/server.edge` flavor must be loaded, because a
 * bundled React's flavor is fixed at build time and can differ from the
 * runtime `process.env.NODE_ENV` (e.g. a prod server bundle that externalizes
 * a development React).
 */
export function getReactNodeEnv(createElement: unknown): ReactNodeEnv {
  return Function.prototype.toString.call(createElement).includes("getOwner")
    ? "development"
    : "production";
}

/**
 * Load `react-dom/server.edge` in the build flavor matching the loaded React
 * runtime (`reactNodeEnv`, from {@link getReactNodeEnv}). Mismatched flavors
 * crash at render time (`dispatcher.getOwner is not a function` when a dev
 * React renders through a prod react-dom), so the two must agree.
 *
 * `react-dom/server.edge` is a CommonJS wrapper that selects its development or
 * production build from `process.env.NODE_ENV` *at module-eval time*. React
 * exposes no per-flavor entrypoint to import directly — the underlying builds
 * are absent from the package `exports` map (importing them throws
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`) — so the only lever is the `NODE_ENV` the
 * wrapper reads while it evaluates.
 *
 * The renderer is loaded via the bundler-visible dynamic `import()` (never a
 * raw `createRequire`): the app's React lives in the bundle's module graph, and
 * a `require()` would pull a *separate* react-dom/React copy outside that graph,
 * reintroducing the dispatcher mismatch this function exists to prevent. That
 * keeps the load in-graph but also means the wrapper evaluates asynchronously,
 * so `NODE_ENV` cannot be set purely synchronously around it.
 *
 * When the runtime `NODE_ENV` already matches the loaded flavor — the steady
 * state in dev and in bundled runtimes (Workers) where `NODE_ENV` is fixed at
 * build time — no swap happens and there is no global side effect. Only on a
 * genuine mismatch is `NODE_ENV` temporarily realigned for the wrapper and
 * restored in `finally`. Callers memoize this loader, so any swap occurs at
 * most once per process, for the duration of a single module evaluation.
 */
export async function importReactDomServerEdge(
  reactNodeEnv: ReactNodeEnv,
): Promise<ReactDomServerEdge> {
  const env = typeof process !== "undefined" && process.env ? process.env : null;
  const previousNodeEnv = env?.NODE_ENV;
  const mustSwap = env != null && previousNodeEnv !== reactNodeEnv;

  if (mustSwap) {
    env.NODE_ENV = reactNodeEnv;
  }
  try {
    return await import("react-dom/server.edge");
  } finally {
    if (mustSwap) {
      if (previousNodeEnv === undefined) {
        delete env.NODE_ENV;
      } else {
        env.NODE_ENV = previousNodeEnv;
      }
    }
  }
}
