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

const STYLED_JSX_STYLE_OPEN = '<style id="__jsx-';
const STYLE_CLOSE = "</style>";

/**
 * Remove the run of styled-jsx `<style id="__jsx-…">` elements `html` ends
 * with: the shell rules `insertStyledJsxBeforePagesRoot` placed right before
 * the React root of a cached document.
 */
export function stripTrailingStyledJsxStyles(html: string): string {
  let end = html.length;
  while (html.endsWith(STYLE_CLOSE, end)) {
    const closeStart = end - STYLE_CLOSE.length;
    const start = html.lastIndexOf(STYLED_JSX_STYLE_OPEN, closeStart);
    // Only strip a single, complete styled-jsx element ending right here.
    if (start === -1 || html.indexOf(STYLE_CLOSE, start) !== closeStart) break;
    end = start;
  }
  return html.slice(0, end);
}

/**
 * Remove the run of styled-jsx `<style id="__jsx-…">` elements `html` starts
 * with: the late rules `appendLateStyledJsxStyles` placed right after the
 * React root of a cached document closed.
 */
export function stripLeadingStyledJsxStyles(html: string): string {
  let start = 0;
  while (html.startsWith(STYLED_JSX_STYLE_OPEN, start)) {
    const close = html.indexOf(STYLE_CLOSE, start);
    if (close === -1) break;
    start = close + STYLE_CLOSE.length;
  }
  return html.slice(start);
}

/**
 * Render the rules registered while ISR regeneration re-rendered a page body.
 *
 * Next.js regenerates the whole document, so its styles always match the
 * body. vinext's regeneration splices a fresh body into the cached document,
 * whose rules were collected from the previous render — interpolated
 * (`${props.color}`) rules get a new id whenever the data changes, so the
 * caller swaps the cached rules around the React root for these. `_document`
 * is not re-rendered, so rules a custom `getInitialProps()` put in the cached
 * `<head>` stay there and are not repeated.
 */
export async function renderRegeneratedStyledJsxStylesHTML(
  styledJsx: PagesStyledJsxCollector,
  cachedHeadHTML: string,
  renderStylesToString: RenderStylesToString,
): Promise<string> {
  const styles = styledJsx.flushStyles().filter((style) => {
    const id = style.props.id;
    return id === undefined || !cachedHeadHTML.includes(`id="${id}"`);
  });
  if (styles.length === 0) return "";
  return renderStylesToString(React.createElement(React.Fragment, null, styles));
}
