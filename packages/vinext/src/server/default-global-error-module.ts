import DefaultGlobalError from "vinext/shims/default-global-error";

/**
 * Module-shaped wrapper around vinext's built-in default global error
 * component. Used as the fallback when an app does not define its own
 * `app/global-error.tsx`. The runtime treats any `{ default: Component }`
 * record as a "global error module", so wrapping the component this way lets
 * us thread the default through the existing `globalErrorModule` plumbing
 * without introducing a parallel code path.
 *
 * Mirrors Next.js's `defaultGlobalErrorPath`
 * (`next/dist/client/components/builtin/global-error.js`), which is selected
 * automatically when the user has not supplied a custom global error file:
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/build/webpack/loaders/next-app-loader/index.ts
 */
export const DEFAULT_GLOBAL_ERROR_MODULE = {
  default: DefaultGlobalError,
} as const;
