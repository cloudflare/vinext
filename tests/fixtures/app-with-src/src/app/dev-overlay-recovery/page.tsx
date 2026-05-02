import { ThrowOnRender } from "./throw-on-render";

// This route has no error.tsx and the fixture has no global-error.tsx, so
// thrown errors propagate all the way up to vinext's DevRecoveryBoundary.
// Used by dev-overlay-recovery.spec.ts to exercise the boundary's
// componentDidCatch → drainPrePaintEffects path that drives URL update for
// soft-navs whose target render fails.
export default function DevOverlayRecoveryPage() {
  return (
    <main>
      <h1 id="recovery-target">Recovery Target</h1>
      <ThrowOnRender />
    </main>
  );
}
