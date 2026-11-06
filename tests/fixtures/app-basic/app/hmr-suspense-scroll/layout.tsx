import { Suspense, type ReactNode } from "react";

// Used by Playwright: app-router/hmr-suspense-scroll.spec.ts. The page
// suspends on every render, so an HMR update committed at urgent priority
// would replace the revealed page with this fallback.
export default function HmrSuspenseScrollLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<p data-testid="hmr-suspense-scroll-fallback">Loading...</p>}>
      {children}
    </Suspense>
  );
}
