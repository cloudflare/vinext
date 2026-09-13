import { NavInfo } from "../nav-info";

/**
 * Dynamic-segment page for the nav-context-hydration regression fixture.
 *
 * The [id] segment exercises the params-carrying side of the navigation runtime
 * RSC bootstrap. Its params field and the value passed to setNavigationContext
 * must reflect the matched segment so useParams() returns the right value during
 * hydration.
 *
 * The test verifies:
 *  1. The SSR HTML renders the correct pathname (e.g. "/nextjs-compat/nav-context-hydration/hello")
 *  2. The HTML bootstrap carries that same pathname
 *  3. The bootstrap params carry { id: "hello" }
 *
 * Without the navigation bootstrap, getServerSnapshot returns "/" during
 * hydration even though SSR rendered the real pathname, triggering React
 * hydration mismatch error #418.
 */
export default function NavContextHydrationDynamicPage() {
  return (
    <div id="nav-context-hydration-dynamic-page">
      <h1>Nav Context Hydration Dynamic Test</h1>
      <NavInfo />
    </div>
  );
}
