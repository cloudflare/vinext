import { VINEXT_PRERENDER_NOT_FOUND_HEADER } from "./headers.js";

/**
 * The path the prerender step requests, with `VINEXT_PRERENDER_NOT_FOUND_HEADER`,
 * to render the deployment's 404 page.
 *
 * Next.js builds that page from its own entry (`/_not-found` in the App
 * Router, `/_error` in the Pages Router), which no route of the app takes
 * part in. So that request never matches a route, not even a top-level
 * dynamic or catch-all segment that would otherwise accept its path. The
 * header, not the path, marks it: a route may generate this path itself.
 */
export const PRERENDER_NOT_FOUND_PATH = "/__vinext_nonexistent_for_404__";

/** Whether `request` is the prerender step's request for the 404 page. */
export function isPrerenderNotFoundRequest(request: Request): boolean {
  return (
    typeof process !== "undefined" &&
    process.env?.VINEXT_PRERENDER === "1" &&
    request.headers.get(VINEXT_PRERENDER_NOT_FOUND_HEADER) === "1"
  );
}

/** Whether `pathname` is the path of the prerender step's 404 request. */
export function isPrerenderNotFoundPathname(pathname: string): boolean {
  return pathname === PRERENDER_NOT_FOUND_PATH || pathname === `${PRERENDER_NOT_FOUND_PATH}/`;
}
