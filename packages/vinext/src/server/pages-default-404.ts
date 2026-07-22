/**
 * Default 404 HTML body for the Pages Router.
 *
 * Used when a Pages Router request does not match any route (and the app has
 * not supplied a custom `pages/404.tsx`). Mirrors the markup Next.js's
 * `pages/_error.tsx` produces for a 404 response: a centered status / message
 * pair plus minified theme CSS and dark-mode media query. The message string
 * `"This page could not be found."` (note the trailing period) is the
 * canonical body asserted by Next.js's deploy suite
 * (`test/e2e/getserversideprops/test/index.test.ts`,
 * `test/e2e/basepath/error-pages.test.ts`).
 *
 * Kept as a hand-rendered HTML literal rather than a React-rendered template
 * because the Pages Router server entry is invoked from both Workers and the
 * dev server before any React-renderer wiring is available for this path —
 * matching the lightweight build-time strategy Next.js uses for its packaged
 * `_error` static fallback. See:
 *   .nextjs-ref/packages/next/src/pages/_error.tsx
 */

const STATUS = 404;
const MESSAGE = "This page could not be found.";

const CSS = `body{color:#000;background:#fff;margin:0}.next-error-h1{border-right:1px solid rgba(0,0,0,.3)}@media (prefers-color-scheme:dark){body{color:#fff;background:#000}.next-error-h1{border-right:1px solid rgba(255,255,255,.3)}}`;

const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width"/><title>${STATUS}: ${MESSAGE}</title><meta name="next-head-count" content="2"/><style data-next-hide-fouc="true">body{display:none}</style><noscript data-next-hide-fouc="true"><style>body{display:block}</style></noscript></head><body><div id="__next"><div style="font-family:system-ui,&quot;Segoe UI&quot;,Roboto,Helvetica,Arial,sans-serif,&quot;Apple Color Emoji&quot;,&quot;Segoe UI Emoji&quot;;height:100vh;text-align:center;display:flex;flex-direction:column;align-items:center;justify-content:center"><div style="line-height:48px"><style>${CSS}</style><h1 class="next-error-h1" style="display:inline-block;margin:0 20px 0 0;padding-right:23px;font-size:24px;font-weight:500;vertical-align:top">${STATUS}</h1><div style="display:inline-block"><h2 style="font-size:14px;font-weight:400;line-height:28px">${MESSAGE}</h2></div></div></div></div></body></html>`;

/**
 * Build the Next.js-compatible default 404 HTML response for the Pages Router.
 * Content-type is `text/html; charset=utf-8`, matching Next.js's
 * `pages-handler` 404 response.
 */
export function buildDefaultPagesNotFoundResponse(): Response {
  return new Response(HTML, {
    status: STATUS,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/** Exported for tests / callers that need the raw HTML body. */
export const DEFAULT_PAGES_NOT_FOUND_HTML = HTML;
