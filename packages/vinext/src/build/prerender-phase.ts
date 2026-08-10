import { PHASE_PRODUCTION_BUILD } from "vinext/shims/constants";

type PrerenderPhaseState = {
  depth: number;
  previousNextPhase: string | undefined;
  previousPrerenderFlag: string | undefined;
};

type PrerenderPhaseEnv = {
  NEXT_PHASE?: string;
  NODE_ENV?: string;
  VINEXT_PRERENDER?: string;
};

const activePrerenderPhases = new WeakMap<PrerenderPhaseEnv, PrerenderPhaseState>();

/**
 * Enter the same process environment phase that Next.js exposes while its
 * static workers execute application code. The returned cleanup is nest-safe:
 * direct prerender helpers can run inside the CLI's broader build scope without
 * overwriting the caller's prior phase when they finish.
 */
export function enterPrerenderPhase(env: PrerenderPhaseEnv = process.env): () => void {
  let state = activePrerenderPhases.get(env);
  if (state) {
    state.depth += 1;
  } else {
    state = {
      depth: 1,
      previousPrerenderFlag: env.VINEXT_PRERENDER,
      previousNextPhase: env.NEXT_PHASE,
    };
    activePrerenderPhases.set(env, state);
  }
  let restored = false;

  env.VINEXT_PRERENDER = "1";
  env.NEXT_PHASE = PHASE_PRODUCTION_BUILD;

  return () => {
    if (restored) return;
    restored = true;
    state.depth -= 1;
    if (state.depth > 0) return;
    activePrerenderPhases.delete(env);

    if (state.previousPrerenderFlag === undefined) delete env.VINEXT_PRERENDER;
    else env.VINEXT_PRERENDER = state.previousPrerenderFlag;

    if (state.previousNextPhase === undefined) delete env.NEXT_PHASE;
    else env.NEXT_PHASE = state.previousNextPhase;
  };
}
