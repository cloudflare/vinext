/**
 * `runtime = 'edge'` prints a deprecation warning, once per process.
 *
 * Next.js warns the first time a route's resolved `runtime` is
 * `edge`/`experimental-edge` — during the build's page-data collection, or
 * (in dev) on first compile of the route — via `Log.warnOnce`
 * (`packages/next/src/build/warn-about-edge-runtime.ts`).
 *
 * vinext has no separate page-data-collection pass, so `isEdgeRuntime` itself
 * carries the warning: every build/dev/request path that classifies a route
 * as edge runs through this one shared check, and a module-level flag gives
 * the same "once per process" dedup Next.js gets from `Log.warnOnce`.
 *
 * This file is isolated from `tests/app-segment-config.test.ts` on purpose —
 * vitest loads each test file with its own module registry, so this test
 * gets a virgin dedup flag regardless of how many times other test files
 * already called `isEdgeRuntime('edge')`.
 *
 * Ported from Next.js: test/e2e/edge-runtime-deprecated/edge-runtime-deprecated.test.ts
 * https://github.com/vercel/next.js/blob/canary/test/e2e/edge-runtime-deprecated/edge-runtime-deprecated.test.ts
 */
import { describe, expect, it, vi } from "vite-plus/test";
import { isEdgeRuntime } from "../packages/vinext/src/server/app-segment-config.js";

const EXPECTED_WARNING =
  'The Edge Runtime is deprecated. You can use the "nodejs" runtime instead.';

describe("isEdgeRuntime deprecation warning", () => {
  it("warns the first time runtime is edge, and only once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(isEdgeRuntime("nodejs")).toBe(false);
      expect(warn).not.toHaveBeenCalled();

      expect(isEdgeRuntime("edge")).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain(EXPECTED_WARNING);

      // A second (and third, via experimental-edge) edge classification
      // must not print the warning again.
      expect(isEdgeRuntime("edge")).toBe(true);
      expect(isEdgeRuntime("experimental-edge")).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
