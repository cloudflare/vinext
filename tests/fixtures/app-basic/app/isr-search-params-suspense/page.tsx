import { Suspense } from "react";
import SearchValue from "./search-value";

// An ISR page whose only query read is useSearchParams() inside Suspense, so
// one stored render serves every query. Only isr.spec.ts requests it.
export const revalidate = 60;

export default function ISRSearchParamsSuspensePage() {
  const timestamp = Date.now();
  return (
    <div data-testid="isr-search-params-suspense-page">
      <p>
        Rendered at: <span data-testid="timestamp">{timestamp}</span>
      </p>
      <Suspense fallback={<p data-testid="search-value-fallback">Loading query</p>}>
        <SearchValue />
      </Suspense>
    </div>
  );
}
