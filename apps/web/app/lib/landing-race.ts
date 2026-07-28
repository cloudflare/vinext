export type RaceSeconds = { vinext: number; nextjs: number };

export type RaceFrame = {
  durationMs: number;
  vinextTime: number;
  nextjsTime: number;
  vinextFill: number;
  nextjsFill: number;
  vinextDone: boolean;
  nextjsDone: boolean;
};

export function getRaceFrame(race: RaceSeconds, progress: number): RaceFrame {
  const longest = Math.max(race.vinext, race.nextjs);
  const simTime = Math.min(1, Math.max(0, progress)) * longest;
  const vinextTime = Math.min(race.vinext, simTime);
  const nextjsTime = Math.min(race.nextjs, simTime);

  return {
    // Real time, not sped up: the fallback build numbers (3.1s / 6.2s) and any
    // realistic live measurement play at true 1:1 wall-clock speed. The cap is
    // a defensive ceiling against a bad/outlier data point, not a UX trim —
    // it sat at 5s before, which clipped the shipped 6.2s fallback and made
    // the finish line arrive a real second before the number it displayed.
    durationMs: Math.min(longest, 10) * 1000,
    vinextTime,
    nextjsTime,
    vinextFill: vinextTime / longest,
    nextjsFill: nextjsTime / longest,
    vinextDone: simTime >= race.vinext,
    nextjsDone: simTime >= race.nextjs,
  };
}
