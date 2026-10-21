import DefaultForbidden from "vinext/shims/default-forbidden";
import DefaultNotFound from "vinext/shims/default-not-found";
import DefaultUnauthorized from "vinext/shims/default-unauthorized";

/**
 * Module-shaped wrappers around vinext's built-in not-found, forbidden and
 * unauthorized components. Used as the fallback when an app does not define
 * its own `app/not-found.tsx` (and has not opted into
 * `app/global-not-found.tsx`), `app/forbidden.tsx` or `app/unauthorized.tsx`.
 * The runtime treats any `{ default: Component }` record as a boundary
 * module, so wrapping the components this way lets us thread the defaults
 * through the existing boundary plumbing without introducing a parallel code
 * path.
 *
 * Mirrors Next.js's `builtin/not-found.js`, `builtin/forbidden.js` and
 * `builtin/unauthorized.js`, which the app loader selects for the root
 * segment when the user has not supplied the file:
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/build/webpack/loaders/next-app-loader/index.ts
 * https://github.com/vercel/next.js/blob/canary/crates/next-core/src/app_structure.rs
 */
export const DEFAULT_NOT_FOUND_MODULE = {
  default: DefaultNotFound,
} as const;

export const DEFAULT_FORBIDDEN_MODULE = {
  default: DefaultForbidden,
} as const;

export const DEFAULT_UNAUTHORIZED_MODULE = {
  default: DefaultUnauthorized,
} as const;

export function getDefaultHttpAccessFallbackModule(statusCode: number) {
  if (statusCode === 404) return DEFAULT_NOT_FOUND_MODULE;
  if (statusCode === 403) return DEFAULT_FORBIDDEN_MODULE;
  if (statusCode === 401) return DEFAULT_UNAUTHORIZED_MODULE;
  return null;
}
