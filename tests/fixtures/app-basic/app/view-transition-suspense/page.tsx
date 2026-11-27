import { Suspense, ViewTransition } from "react";

// Server component importing Suspense beside ViewTransition from "react".
export default function ViewTransitionSuspensePage() {
  return (
    <ViewTransition>
      <Suspense fallback={<p>loading</p>}>
        <p data-testid="vt-suspense-content">suspense beside view transition</p>
      </Suspense>
    </ViewTransition>
  );
}
