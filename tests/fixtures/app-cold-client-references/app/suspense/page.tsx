import { Suspense } from "react";
import { SlowBoundary } from "./slow-boundary";

export const dynamic = "force-dynamic";

// The boundary's client module is still loading on the first request, so the
// shell streams the fallback instead of waiting for the module.
export default function SuspensePage() {
  return (
    <main>
      <h1>suspense</h1>
      <Suspense fallback={<p data-testid="fallback">loading</p>}>
        <SlowBoundary />
      </Suspense>
    </main>
  );
}
