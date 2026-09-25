import { Suspense, type ReactNode } from "react";

// Holds the panel page back long enough for a navigation that keeps the panel
// (it has no match for /other) to commit before the page first renders.
async function AfterDelay({ children }: { children: ReactNode }) {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  return children;
}

export default function KeptClientPagePanelLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<p data-testid="kept-client-page-fallback">loading</p>}>
      <AfterDelay>{children}</AfterDelay>
    </Suspense>
  );
}
