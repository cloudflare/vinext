import DefaultNotFound from "vinext/shims/default-not-found";

/**
 * Module-shaped wrapper around vinext's built-in default not-found component.
 * Used as the fallback when an app does not define its own `app/not-found.tsx`
 * (and has not opted into `app/global-not-found.tsx`). The runtime treats any
 * `{ default: Component }` record as a "not-found module", so wrapping the
 * component this way lets us thread the default through the existing
 * `rootNotFoundModule` plumbing without introducing a parallel code path.
 *
 * Mirrors Next.js's `defaultNotFoundPath`
 * (`next/dist/client/components/builtin/not-found.js`), which is selected
 * automatically when the user has not supplied a custom not-found file:
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/build/webpack/loaders/next-app-loader/index.ts
 */
export const DEFAULT_NOT_FOUND_MODULE = {
  default: DefaultNotFound,
} as const;
