import {
  resolveAppPageSpecialError,
  resolveAppPageSpecialErrorStoredHeaders,
  type AppPageSpecialError,
} from "./app-page-execution.js";
import { copyLinkHeaderProvenance } from "./app-response-header-provenance.js";

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
  /**
   * The special error whose status and `location` a static render whose shell
   * `shellError` rejected takes: the shell error, unless an HTTP error the
   * document reported first wins over it. Its document is still the shell
   * error's.
   */
  resolveShellSpecialError: (shellError: AppPageSpecialError) => AppPageSpecialError;
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
 * That holds for the error that rejects the shell too: the render sends that
 * error's document with the status of the error that wins.
 *
 * Ported from Next.js: packages/next/src/server/app-render/app-render.tsx
 * (`setHTTPAccessFallbackOrRedirectStatus` in `prerenderToStream`)
 * https://github.com/vercel/next.js/blob/v16.4.6/packages/next/src/server/app-render/app-render.tsx
 */
export function createAppPageStaticGenerationStatusCapture(
  basePath: string | undefined,
): AppPageStaticGenerationStatusCapture {
  let captured: AppPageSpecialError | null = null;
  const record = (specialError: AppPageSpecialError): void => {
    if (captured === null || (specialError.kind === "redirect" && captured.kind !== "redirect")) {
      captured = specialError;
    }
  };
  return {
    capture(error) {
      const specialError = resolveAppPageSpecialError(error);
      if (specialError) record(specialError);
    },
    resolveShellSpecialError(shellError) {
      // The shell's error is usually reported already. Recording it again
      // changes nothing, as the first error of its kind wins.
      record(shellError);
      return captured ?? shellError;
    },
    get() {
      if (captured === null) return null;
      const headers = resolveAppPageSpecialErrorStoredHeaders(captured, basePath);
      return { status: captured.statusCode, ...(headers ? { headers } : {}) };
    },
  };
}

/**
 * The document of the special error that rejected a static render's shell,
 * sent with the status and `location` of `statusError`, the error that wins.
 * A response that isn't the shell error's own document, such as a 500 from a
 * failing boundary, is left alone.
 */
export function applyAppPageShellSpecialErrorStatus(
  response: Response,
  shellError: AppPageSpecialError,
  statusError: AppPageSpecialError,
  basePath: string | undefined,
): Response {
  if (statusError === shellError || response.status !== shellError.statusCode) return response;
  const headers = new Headers(response.headers);
  const location = resolveAppPageSpecialErrorStoredHeaders(statusError, basePath)?.location;
  if (location === undefined) headers.delete("location");
  else headers.set("location", location);
  const statusResponse = new Response(response.body, { headers, status: statusError.statusCode });
  copyLinkHeaderProvenance(response.headers, statusResponse.headers);
  return statusResponse;
}
