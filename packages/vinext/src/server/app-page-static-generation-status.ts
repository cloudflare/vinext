import {
  resolveAppPageSpecialError,
  resolveAppPageSpecialErrorStoredHeaders,
  type AppPageSpecialError,
} from "./app-page-execution.js";

/** The status and stored headers, such as a redirect's `location`, of a render. */
export type AppPageStaticGenerationStatus = {
  status: number;
  headers?: Record<string, string>;
};

export type AppPageStaticGenerationStatusCapture = {
  /** Observe an error the document's render reported. */
  capture: (error: unknown) => void;
  /**
   * The status of a static render whose shell rendered, from the HTTP errors
   * its document's render reported, if any did.
   */
  get: () => AppPageStaticGenerationStatus | null;
};

/**
 * Collects the notFound(), forbidden(), unauthorized(), redirect() and
 * permanentRedirect() errors a document's render reports, as Next.js's static
 * generation does. A static render sets its status from them, including one a
 * Suspense boundary caught, so a prerendered page answers 404 (or 307 with its
 * `location`) beside the layout and Suspense fallback it prerendered.
 * A request-time render streams its shell first, so it stays a 200.
 *
 * A redirect wins over an access fallback. Within each, the first error wins.
 *
 * Ported from Next.js: packages/next/src/server/app-render/app-render.tsx
 * (`setHTTPAccessFallbackOrRedirectStatus` in `prerenderToStream`)
 * https://github.com/vercel/next.js/blob/v16.4.6/packages/next/src/server/app-render/app-render.tsx
 */
export function createAppPageStaticGenerationStatusCapture(
  basePath: string | undefined,
): AppPageStaticGenerationStatusCapture {
  let captured: AppPageSpecialError | null = null;
  return {
    capture(error) {
      const specialError = resolveAppPageSpecialError(error);
      if (!specialError) return;
      if (captured === null || (specialError.kind === "redirect" && captured.kind !== "redirect")) {
        captured = specialError;
      }
    },
    get() {
      if (captured === null) return null;
      const headers = resolveAppPageSpecialErrorStoredHeaders(captured, basePath);
      return { status: captured.statusCode, ...(headers ? { headers } : {}) };
    },
  };
}
