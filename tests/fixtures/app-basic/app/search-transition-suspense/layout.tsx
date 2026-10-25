import { Suspense, type ReactNode } from "react";

export default function SearchTransitionSuspenseLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<p data-testid="search-transition-layout-fallback">Loading…</p>}>
      {children}
    </Suspense>
  );
}
