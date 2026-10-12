import type { ReactNode } from "react";

// Used by Playwright: app-router/client-page-search-params-hmr.spec.ts edits
// this marker to push an RSC update.
export default function HmrClientPageSearchParamsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <p data-testid="hmr-client-page-marker">before edit</p>
      {children}
    </>
  );
}
