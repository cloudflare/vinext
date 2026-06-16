import { addBasePathToPathname } from "../utils/base-path.js";
import { escapeHtmlAttr } from "./html.js";
import {
  getNextErrorDigest,
  parseNextHttpErrorDigest,
  parseNextRedirectDigest,
} from "./next-error-digest.js";

type SsrErrorMetaRenderOptions = {
  basePath?: string;
  nodeEnv?: string;
};

type SsrErrorMetaRenderer = {
  capture: (error: unknown) => void;
  flush: () => string;
};

const PERMANENT_REDIRECT_STATUS = 308;

function prefixRedirectLocation(location: string, basePath?: string): string {
  if (!basePath || !location.startsWith("/")) {
    return location;
  }

  const hashIndex = location.indexOf("#");
  const queryIndex = location.indexOf("?");
  const pathnameEnd =
    queryIndex === -1
      ? hashIndex === -1
        ? location.length
        : hashIndex
      : hashIndex === -1
        ? queryIndex
        : Math.min(queryIndex, hashIndex);
  const pathname = location.slice(0, pathnameEnd);

  return addBasePathToPathname(pathname, basePath) + location.slice(pathnameEnd);
}

function buildRedirectRefreshMeta(location: string, status: number): string {
  const delay = status === PERMANENT_REDIRECT_STATUS ? 0 : 1;
  return (
    '<meta id="__next-page-redirect" http-equiv="refresh" content="' +
    delay +
    ";url=" +
    escapeHtmlAttr(location) +
    '"/>'
  );
}

/**
 * Renders the redirect refresh meta tag directly from an already-resolved
 * redirect URL, bypassing digest re-parsing. The metadata document-redirect
 * path (`buildMetadataRedirectHtmlResponse`) resolves the target up front —
 * basePath applied, percent-encoding intact — so the URL is ready to emit as-is.
 *
 * Emitting the resolved URL directly mirrors Next.js's
 * `make-get-server-inserted-html`, which renders the raw
 * `getURLFromRedirectError(error)` URL verbatim. That also keeps this path
 * independent of digest encoding differences (raw canonical vs vinext-encoded).
 */
export function renderRedirectRefreshMetaTag(url: string, status: number): string {
  return buildRedirectRefreshMeta(url, status);
}

function renderSsrErrorMetaTag(error: unknown, options: SsrErrorMetaRenderOptions): string {
  const digest = getNextErrorDigest(error);
  if (!digest) return "";

  const httpError = parseNextHttpErrorDigest(digest);
  if (httpError) {
    // Output format matches Next.js's `make-get-server-inserted-html.tsx`,
    // which serializes these meta tags via React's HTML renderer. React's
    // void-element output uses no space before `/>`, and Next.js tests assert
    // on that exact substring (e.g. `'<meta name="robots" content="noindex"/>'`).
    // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/app-render/make-get-server-inserted-html.tsx
    let html = '<meta name="robots" content="noindex"/>';
    if ((options.nodeEnv ?? process.env.NODE_ENV) === "development") {
      html += '<meta name="next-error" content="not-found"/>';
    }
    return html;
  }

  const redirect = parseNextRedirectDigest(digest);
  if (!redirect) return "";

  return buildRedirectRefreshMeta(
    prefixRedirectLocation(redirect.url, options.basePath),
    redirect.status,
  );
}

export function renderSsrErrorMetaTags(
  errors: readonly unknown[],
  options: SsrErrorMetaRenderOptions = {},
): string {
  let html = "";

  for (const error of errors) {
    html += renderSsrErrorMetaTag(error, options);
  }

  return html;
}

export function createSsrErrorMetaRenderer(
  options: SsrErrorMetaRenderOptions = {},
): SsrErrorMetaRenderer {
  const capturedErrors: unknown[] = [];
  let flushedUntil = 0;

  return {
    capture(error) {
      capturedErrors.push(error);
    },
    flush() {
      if (flushedUntil >= capturedErrors.length) return "";

      const html = renderSsrErrorMetaTags(capturedErrors.slice(flushedUntil), options);
      flushedUntil = capturedErrors.length;
      return html;
    },
  };
}
