import { describe, expect, it } from "vite-plus/test";
import { enterPrerenderPhase } from "../packages/vinext/src/build/prerender-phase.js";
import { PHASE_PRODUCTION_BUILD } from "../packages/vinext/src/shims/constants.js";

describe("prerender process phase", () => {
  it("exposes the Next production-build phase and removes it afterward", () => {
    const env: Record<string, string | undefined> = {};

    const restore = enterPrerenderPhase(env);
    expect(env).toMatchObject({
      VINEXT_PRERENDER: "1",
      NEXT_PHASE: PHASE_PRODUCTION_BUILD,
    });

    restore();
    expect(env.VINEXT_PRERENDER).toBeUndefined();
    expect(env.NEXT_PHASE).toBeUndefined();
  });

  it("restores an ordinary runtime phase after overlapping prerender scopes", () => {
    const env: Record<string, string | undefined> = {
      VINEXT_PRERENDER: "runtime-control",
      NEXT_PHASE: "phase-production-server",
    };

    const restoreOuter = enterPrerenderPhase(env);
    const restoreInner = enterPrerenderPhase(env);
    restoreOuter();
    expect(env.NEXT_PHASE).toBe(PHASE_PRODUCTION_BUILD);

    restoreInner();
    expect(env).toEqual({
      VINEXT_PRERENDER: "runtime-control",
      NEXT_PHASE: "phase-production-server",
    });
  });
});
