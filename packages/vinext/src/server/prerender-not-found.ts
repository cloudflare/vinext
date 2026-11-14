/**
 * The path the prerender step requests to render the deployment's 404 page.
 *
 * Next.js builds that page from its own entry (`/_not-found` in the App
 * Router, `/_error` in the Pages Router), which no route of the app takes
 * part in. So while prerendering, this path never matches a route, not even
 * a top-level dynamic or catch-all segment that would otherwise accept it.
 */
export const PRERENDER_NOT_FOUND_PATH = "/__vinext_nonexistent_for_404__";

/** Whether a prerender-phase request for `pathname` is the 404 page's render. */
export function isPrerenderNotFoundPathname(pathname: string): boolean {
  return (
    typeof process !== "undefined" &&
    process.env?.VINEXT_PRERENDER === "1" &&
    (pathname === PRERENDER_NOT_FOUND_PATH || pathname === `${PRERENDER_NOT_FOUND_PATH}/`)
  );
}
