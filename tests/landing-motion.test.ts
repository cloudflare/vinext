import { describe, expect, it } from "vite-plus/test";
import {
  hasLandingSequencePlayed,
  LANDING_RACE_PLAYED_KEY,
  LANDING_SWAP_PLAYED_KEY,
  markLandingSequencePlayed,
  type LandingPlaybackKey,
} from "../apps/web/app/lib/landing-playback";
import { getRaceFrame } from "../apps/web/app/lib/landing-race";

describe("landing build race", () => {
  it("persists each one-play state in session storage", () => {
    const keys = [
      LANDING_RACE_PLAYED_KEY,
      LANDING_SWAP_PLAYED_KEY,
    ] satisfies readonly LandingPlaybackKey[];

    for (const key of keys) {
      const values = new Map<string, string>();
      const storage = {
        getItem: (storageKey: string) => values.get(storageKey) ?? null,
        setItem: (storageKey: string, value: string) => values.set(storageKey, value),
      };

      expect(hasLandingSequencePlayed(storage, key)).toBe(false);
      markLandingSequencePlayed(storage, key);
      expect(values.get(key)).toBe("1");
      expect(hasLandingSequencePlayed(storage, key)).toBe(true);
    }
  });

  it("keeps landing sequences functional when session storage is unavailable", () => {
    const storage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };

    expect(hasLandingSequencePlayed(storage, LANDING_RACE_PLAYED_KEY)).toBe(false);
    expect(() => markLandingSequencePlayed(storage, LANDING_RACE_PLAYED_KEY)).not.toThrow();
    expect(hasLandingSequencePlayed(null, LANDING_SWAP_PLAYED_KEY)).toBe(false);
    expect(() => markLandingSequencePlayed(null, LANDING_SWAP_PLAYED_KEY)).not.toThrow();
  });

  it("uses the slower vinext build as the race duration and bar denominator", () => {
    const halfway = getRaceFrame({ vinext: 6, nextjs: 3 }, 0.5);

    expect(halfway).toEqual({
      durationMs: 6_000,
      vinextTime: 3,
      nextjsTime: 3,
      vinextFill: 0.5,
      nextjsFill: 0.5,
      vinextDone: false,
      nextjsDone: true,
    });

    expect(getRaceFrame({ vinext: 6, nextjs: 3 }, 1)).toEqual({
      durationMs: 6_000,
      vinextTime: 6,
      nextjsTime: 3,
      vinextFill: 1,
      nextjsFill: 0.5,
      vinextDone: true,
      nextjsDone: true,
    });
  });

  it("plays at true 1:1 wall-clock speed for the shipped fallback times", () => {
    // Regression guard: 6.2s used to get clipped by the old 5s cap, so the
    // finish line landed a full second before the "6.2s" it was displaying.
    expect(getRaceFrame({ vinext: 3.1, nextjs: 6.2 }, 1).durationMs).toBe(6_200);
  });

  it("only compresses playback once a build time clears the defensive ceiling", () => {
    expect(getRaceFrame({ vinext: 4, nextjs: 12 }, 1).durationMs).toBe(10_000);
  });

  it("finishes equal builds together with equal full-width bars", () => {
    expect(getRaceFrame({ vinext: 4, nextjs: 4 }, 0.5)).toEqual({
      durationMs: 4_000,
      vinextTime: 2,
      nextjsTime: 2,
      vinextFill: 0.5,
      nextjsFill: 0.5,
      vinextDone: false,
      nextjsDone: false,
    });

    expect(getRaceFrame({ vinext: 4, nextjs: 4 }, 1)).toEqual({
      durationMs: 4_000,
      vinextTime: 4,
      nextjsTime: 4,
      vinextFill: 1,
      nextjsFill: 1,
      vinextDone: true,
      nextjsDone: true,
    });
  });
});
