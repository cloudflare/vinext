import { isBailoutToCSRError, isDynamicServerError } from "vinext/shims/navigation-errors";
import { isPprFallbackShellAbortError } from "vinext/shims/ppr-fallback-shell";
import { isValidNavigationSignalError } from "../utils/navigation-signal.js";
import { isAppRenderAbortError } from "./app-render-abort-error.js";
import { VINEXT_PRERENDER_RENDER_ERROR_HEADER } from "./headers.js";
import { isPrerenderBindingsUnavailableError } from "./prerender-bindings-unavailable.js";

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
    !isValidNavigationSignalError(error) &&
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
