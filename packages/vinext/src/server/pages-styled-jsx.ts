/**
 * Pages Router styled-jsx SSR output, shared by the dev (`dev-server.ts`) and
 * production/Workers (`pages-page-response.ts`) renderers.
 *
 * Ported from Next.js: packages/next/src/server/render.tsx
 * (search for `jsxStyleRegistry`)
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/server/render.tsx
 *
 * Placement is a deliberate divergence. Next.js renders the registry as
 * `_document`'s `styles` at the end of `<head>`, and keeps CSS-in-JS winning
 * the cascade by inserting stylesheets it loads later *before* them
 * (`noscript[data-n-css]`). vinext's client loads page CSS through Vite, which
 * appends `<link rel="stylesheet">` to the end of `<head>` — for client
 * navigations, and whenever it does not recognize the server-rendered link
 * (e.g. one carrying the `?dpl=` deployment id). Rules at the end of `<head>`
 * would then lose to those stylesheets (Next.js's
 * test/e2e/app-dir/scss/with-styled-jsx asserts they win). vinext therefore
 * emits the shell's rules immediately before `<div id="__next">` — where
 * Next.js already emits styles registered outside `_document`'s `styles`
 * (`styledJsxInsertedHTML`) — which is after every `<head>` stylesheet in
 * document order and outside the hydrated React root. Styles returned by a
 * custom `_document.getInitialProps()` still go in `<head>`, as in Next.js.
 */
import React from "react";
import type { PagesStyledJsxCollector } from "vinext/shims/styled-jsx-registry";

type RenderStylesToString = (element: React.ReactElement) => Promise<string>;

/**
 * Flush a render's styled-jsx registry into `<style id="__jsx-…">` HTML.
 * Returns "" (without rendering) when styled-jsx is not in use or nothing new
 * was registered.
 *
 * Next.js's Node runtime reaches these styles through
 * `ctx.defaultGetInitialProps()`, which applies the CSP nonce, so vinext
 * forwards the request's script nonce too.
 */
export async function renderStyledJsxStylesHTML(
  styledJsx: PagesStyledJsxCollector | null | undefined,
  nonce: string | undefined,
  renderStylesToString: RenderStylesToString,
): Promise<string> {
  const styles = styledJsx?.flushStyles(nonce);
  if (!styles || styles.length === 0) return "";
  return renderStylesToString(React.createElement(React.Fragment, null, styles));
}

const PAGES_ROOT_OPEN = '<div id="__next">';
const PAGES_ROOT_CLOSE = "</div>";

/**
 * Insert styles collected from the shell render immediately before the React
 * root. `html` is the document up to and including `<div id="__next">` (the
 * default shell and `next/document`'s `<Main />` both render exactly that tag
 * right before the streamed body), or a whole document whose first root tag
 * is the React root.
 */
export function insertStyledJsxBeforePagesRoot(html: string, stylesHTML: string): string {
  if (!stylesHTML) return html;
  const rootOpen = html.endsWith(PAGES_ROOT_OPEN)
    ? html.length - PAGES_ROOT_OPEN.length
    : html.indexOf(PAGES_ROOT_OPEN);
  if (rootOpen !== -1) return html.slice(0, rootOpen) + stylesHTML + html.slice(rootOpen);
  const headClose = html.indexOf("</head>");
  if (headClose === -1) return html + stylesHTML;
  return html.slice(0, headClose) + stylesHTML + html.slice(headClose);
}

/**
 * Append styles registered after the shell was rendered — content that
 * resolved inside a Suspense boundary while the body streamed — to the
 * document suffix.
 *
 * Next.js waits for `allReady` before building the document, so it collects
 * every rule up front. vinext keeps streaming the Pages body, so rules that
 * arrive after the shell go right after the React root closes instead:
 * outside the hydrated tree, where styled-jsx's client registry still adopts
 * them by id. The suffix always starts by closing `<div id="__next">`.
 */
export async function appendLateStyledJsxStyles(
  shellSuffix: string,
  styledJsx: PagesStyledJsxCollector | null | undefined,
  nonce: string | undefined,
  renderStylesToString: RenderStylesToString,
): Promise<string> {
  const stylesHTML = await renderStyledJsxStylesHTML(styledJsx, nonce, renderStylesToString);
  if (!stylesHTML) return shellSuffix;
  if (shellSuffix.startsWith(PAGES_ROOT_CLOSE)) {
    return PAGES_ROOT_CLOSE + stylesHTML + shellSuffix.slice(PAGES_ROOT_CLOSE.length);
  }
  const bodyClose = shellSuffix.lastIndexOf("</body>");
  if (bodyClose === -1) return shellSuffix + stylesHTML;
  return shellSuffix.slice(0, bodyClose) + stylesHTML + shellSuffix.slice(bodyClose);
}

/**
 * A `<style id="__jsx-…">` element: the only markup styled-jsx's registry
 * produces (`registry.styles()`). A page render's rules carry these ids
 * wherever they end up — around the React root, or in `<head>` when a custom
 * `_document` returned them from `ctx.defaultGetInitialProps()` /
 * `Document.getInitialProps(ctx)` — while styles `_document` owns itself
 * (other CSS-in-JS libraries, inline `<style>` tags) never do. `_document`'s
 * own render is outside the registry, so its `<style jsx>` renders nothing.
 */
const STYLED_JSX_STYLE_ELEMENT_RE = /<style id="__jsx-[^"]*"[^>]*>[\s\S]*?<\/style>/g;

/**
 * Swap a cached document's styled-jsx rules for the ones ISR regeneration
 * collected (`stylesHTML`).
 *
 * Next.js regenerates the whole document, so its styles always match the
 * body. vinext's regeneration splices a fresh body into the cached document,
 * whose rules came from the previous render: interpolated (`${props.color}`)
 * rules get a new id whenever the data changes, and a rule the new render no
 * longer registers (a `<style jsx global>` behind a condition) must stop
 * applying. Every page rule outside the React root is therefore removed —
 * `beforeRoot` is the document up to `<div id="__next">`, `afterRoot` what
 * follows the root up to `__NEXT_DATA__` (late Suspense rules) — and the
 * regenerated rules go where the page's rules were rendered: at the first
 * rule in `<head>` (custom `_document` path, `headEnd` is `</head>`'s index
 * in `beforeRoot`) or else right before the React root.
 */
export function replaceStyledJsxStyles(
  beforeRoot: string,
  headEnd: number,
  afterRoot: string,
  stylesHTML: string,
): { beforeRoot: string; afterRoot: string } {
  let firstRule = -1;
  const withoutRules = beforeRoot.replace(STYLED_JSX_STYLE_ELEMENT_RE, (rule, offset: number) => {
    if (firstRule === -1) firstRule = offset;
    return "";
  });
  // Head rules precede body ones, so the first rule tells where they went.
  const insertAt = firstRule !== -1 && firstRule < headEnd ? firstRule : withoutRules.length;
  return {
    beforeRoot: withoutRules.slice(0, insertAt) + stylesHTML + withoutRules.slice(insertAt),
    afterRoot: afterRoot.replace(STYLED_JSX_STYLE_ELEMENT_RE, ""),
  };
}
