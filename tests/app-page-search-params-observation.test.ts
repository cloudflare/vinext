import { describe, expect, it } from "vite-plus/test";
import { makeObservedAppPageSearchParamsThenable } from "../packages/vinext/src/server/app-page-search-params-observation.js";
import { runWithStaticNavigationShellScope } from "../packages/vinext/src/server/app-static-navigation-shell.js";
import {
  createPprFallbackShellState,
  preparePprFallbackShellFinalRender,
  runWithPprFallbackShellState,
} from "../packages/vinext/src/shims/ppr-fallback-shell.js";

async function withStaticNavigationShell<T>(
  fn: (state: ReturnType<typeof createPprFallbackShellState>) => Promise<T> | T,
): Promise<T> {
  const state = createPprFallbackShellState({
    fallbackParamNames: [],
    routePattern: "/test",
  });
  preparePprFallbackShellFinalRender(state);

  try {
    return await runWithPprFallbackShellState(state, () =>
      runWithStaticNavigationShellScope({ includeRuntimeRequestApis: false }, () => fn(state)),
    );
  } finally {
    state.abortController.abort();
  }
}

describe("app page searchParams observation", () => {
  it("ignores empty-key promise continuation access during static shell rendering", async () => {
    await withStaticNavigationShell(async (state) => {
      const searchParams = makeObservedAppPageSearchParamsThenable({});

      await searchParams.then(() => undefined);

      expect(state.hasDynamicBoundary).toBe(false);
    });
  });

  it("still suspends the static shell on explicit searchParams property access", async () => {
    await withStaticNavigationShell(async (state) => {
      const searchParams = makeObservedAppPageSearchParamsThenable({});
      const resolved = await searchParams;
      let thrown: unknown;

      try {
        void resolved.q;
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Promise);
      expect(state.hasDynamicBoundary).toBe(true);
    });
  });
});
