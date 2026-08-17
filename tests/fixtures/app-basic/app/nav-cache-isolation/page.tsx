// Used by Vitest: app-router-production-server.test.ts — a cacheable page kept
// out of the other ISR tests so cross-request navigation-state assertions do
// not depend on which test primed the cache first.
export const revalidate = 60;

export default function NavCacheIsolationPage() {
  return <div data-testid="nav-cache-isolation-page">Nav cache isolation</div>;
}
