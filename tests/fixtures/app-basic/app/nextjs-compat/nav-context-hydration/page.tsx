import { NavInfo } from "./nav-info";

/**
 * Static page for the nav-context-hydration regression fixture.
 *
 * Renders the <NavInfo /> client component so the test can assert:
 *  1. The SSR HTML contains the correct pathname and searchParams values
 *     (rendered server-side via the RSC→SSR nav context pass-through).
 *  2. The HTML contains a __VINEXT_RSC_NAV__ script tag with a payload
 *     whose pathname/searchParams match what was SSR-rendered, ensuring
 *     useSyncExternalStore's getServerSnapshot will agree with the
 *     SSR-rendered HTML during client hydration.
 *
 * Without __VINEXT_RSC_NAV__, getServerSnapshot returns "/" and empty
 * URLSearchParams regardless of the actual request URL, causing React to
 * detect a mismatch between the server-rendered HTML and the client snapshot
 * (React hydration error #418).
 */
export default function NavContextHydrationPage() {
  return (
    <div id="nav-context-hydration-page">
      <h1>Nav Context Hydration Test</h1>
      <NavInfo />
    </div>
  );
}
