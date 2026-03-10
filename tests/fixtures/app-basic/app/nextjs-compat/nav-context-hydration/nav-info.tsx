"use client";

import { usePathname, useSearchParams } from "next/navigation";

/**
 * "use client" component for the nav-context-hydration regression fixture.
 *
 * Renders usePathname() and useSearchParams() during SSR so the test can
 * assert the SSR-rendered values match the __VINEXT_RSC_NAV__ payload that
 * the browser entry restores before hydration.
 *
 * The fix under test: __VINEXT_RSC_NAV__ is embedded in <head> as a script
 * tag so that useSyncExternalStore's getServerSnapshot returns the same
 * pathname/searchParams that were rendered on the server, preventing React
 * hydration mismatch error #418.
 *
 * Without the fix, getServerSnapshot falls back to "/" and empty search
 * params regardless of the actual request URL, producing a mismatch against
 * the SSR-rendered HTML.
 */
export function NavInfo() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  return (
    <div id="nav-info">
      <span id="nav-pathname">{pathname}</span>
      <span id="nav-search-q">{searchParams.get("q") ?? ""}</span>
      <span id="nav-search-page">{searchParams.get("page") ?? ""}</span>
      <span id="nav-search-string">{searchParams.toString()}</span>
    </div>
  );
}
