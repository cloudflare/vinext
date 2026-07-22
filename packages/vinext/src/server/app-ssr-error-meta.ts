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

  const delay = redirect.status === PERMANENT_REDIRECT_STATUS ? 0 : 1;
  const location = prefixRedirectLocation(redirect.url, options.basePath);
  return (
    '<meta id="__next-page-redirect" http-equiv="refresh" content="' +
    delay +
    ";url=" +
    escapeHtmlAttr(location) +
    '"/>'
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
