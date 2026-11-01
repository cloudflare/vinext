import { isBailoutToCSRError, isDynamicServerError } from "vinext/shims/navigation-errors";
import { isPprFallbackShellAbortError } from "vinext/shims/ppr-fallback-shell";
import { isNavigationSignalError } from "../utils/navigation-signal.js";
import { isAppRenderAbortError } from "./app-render-abort-error.js";
import { VINEXT_PRERENDER_RENDER_ERROR_HEADER } from "./headers.js";

/**
 * Marks the errors that the build-time prerender's stand-in for
 * `cloudflare:workers` throws, as its bindings aren't available there. A route
 * that reads them is left to cache warming rather than failing the build.
 */
export const PRERENDER_BINDINGS_UNAVAILABLE_KEY = "vinext.prerender.bindingsUnavailable";

function isPrerenderBindingsUnavailableError(error: unknown): boolean {
  const marker = Symbol.for(PRERENDER_BINDINGS_UNAVAILABLE_KEY);
  // Follow a wrapping error's cause, without looping on a cyclic chain.
  for (let depth = 0; depth < 10 && error !== null && typeof error === "object"; depth++) {
    if (Reflect.get(error, marker) === true) return true;
    error = Reflect.get(error, "cause");
  }
  return false;
}

/**
 * Whether an error that a prerender's render reports fails the build. As in
 * `next build`, every error does except the ones Next.js expects: a redirect
 * or HTTP access fallback, a bail-out to client rendering, dynamic usage and
 * an aborted render. This includes an error an error boundary catches, or one
 * thrown inside Suspense. A binding that the prerender can't provide doesn't
 * fail it either.
 *
 * Ported from Next.js: packages/next/src/server/app-render/create-error-handler.tsx
 * (getDigestForWellKnownError, isUserLandError)
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/server/app-render/create-error-handler.tsx
 */
export function isPrerenderBuildFailingError(error: unknown): boolean {
  return (
    !isNavigationSignalError(error) &&
    !isBailoutToCSRError(error) &&
    !isDynamicServerError(error) &&
    !isAppRenderAbortError(error) &&
    !isPprFallbackShellAbortError(error) &&
    !isPrerenderBindingsUnavailableError(error)
  );
}

/** Marks a prerender response whose render reported a build-failing error. */
export function markPrerenderRenderError(response: Response): Response {
  response.headers.set(VINEXT_PRERENDER_RENDER_ERROR_HEADER, "1");
  return response;
}
