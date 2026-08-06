/**
 * A client-only helper strip, loaded via next/dynamic with `ssr: false` from
 * the app shell. Its presence in the hydrated DOM (and absence from server
 * HTML) is asserted by the e2e suite.
 */
export const HelperDock = () => (
  <div data-testid="helper-dock" role="complementary">
    Client-only helper dock
  </div>
);
