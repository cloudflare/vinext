import { isBailoutToCSRError, isDynamicServerError } from "vinext/shims/navigation-errors";
import { isPprFallbackShellAbortError } from "vinext/shims/ppr-fallback-shell";
import { isValidNavigationSignalError } from "../utils/navigation-signal.js";
import { isAppRenderAbortError } from "./app-render-abort-error.js";
import { copyLinkHeaderProvenance } from "./app-response-header-provenance.js";
import {
  VINEXT_PRERENDER_NOT_FOUND_RENDER_ERROR,
  VINEXT_PRERENDER_RENDER_ERROR_HEADER,
} from "./headers.js";
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

/**
 * Marks a prerender response whose render reported a build-failing error, as
 * the not-found page's own render with `isNotFoundPage`.
 */
export function markPrerenderRenderError(response: Response, isNotFoundPage = false): Response {
  response.headers.set(
    VINEXT_PRERENDER_RENDER_ERROR_HEADER,
    isNotFoundPage ? VINEXT_PRERENDER_NOT_FOUND_RENDER_ERROR : "1",
  );
  return response;
}

export type PrerenderRenderErrorTracker = {
  /** Notes an error the render reports. */
  note(error: unknown): void;
  /**
   * Whether the render reported an error that fails a prerender, dynamic or
   * not. A render that turned dynamic doesn't fail, so a caller reads this only
   * once it has checked the render's dynamic usage, or uses `failsBuild`.
   */
  reported: () => boolean;
  /** Whether a noted error fails the build, as the render didn't turn dynamic. */
  failsBuild(isDynamic: () => boolean): boolean;
  /** Marks the response when the render fails the build. */
  finalize(response: Response, isDynamic: () => boolean): Response;
};

/**
 * Tracks the errors a prerender's render reports, while `isTracking()` holds,
 * for the not-found page's own render with `isNotFoundPage`.
 */
export function createPrerenderRenderErrorTracker(
  isTracking: () => boolean,
  isNotFoundPage = false,
): PrerenderRenderErrorTracker {
  let reported = false;
  const failsBuild = (isDynamic: () => boolean): boolean => reported && !isDynamic();
  return {
    note(error) {
      if (!reported && isTracking() && isPrerenderBuildFailingError(error)) reported = true;
    },
    reported: () => reported,
    failsBuild,
    finalize(response, isDynamic) {
      return failsBuild(isDynamic) ? markPrerenderRenderError(response, isNotFoundPage) : response;
    },
  };
}

/**
 * Reads a prerender response's whole body first, so its render has reported
 * every error by the time the response is finalized.
 */
export async function bufferPrerenderResponse(response: Response): Promise<Response> {
  const buffered = new Response(await response.arrayBuffer(), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  copyLinkHeaderProvenance(response.headers, buffered.headers);
  return buffered;
}
