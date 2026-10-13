/**
 * Run a route-transition scroll with `scroll-behavior: auto` on `<html>`.
 *
 * Ported from Next.js:
 * packages/next/src/shared/lib/router/utils/disable-smooth-scroll.ts
 *
 * Since Next.js 16 (vercel/next.js#84102) the override is opt-in: it only
 * applies when the root element carries `data-scroll-behavior="smooth"`.
 * Without the attribute, a page-level `scroll-behavior: smooth` is respected
 * and route-change scrolls animate. Hash-only navigations never use this
 * helper, so in-page anchor jumps keep the smooth behavior.
 */
export function disableSmoothScrollDuringRouteTransition(fn: () => void): void {
  const htmlElement = document.documentElement;
  if (htmlElement.dataset.scrollBehavior !== "smooth") {
    fn();
    return;
  }

  const previousScrollBehavior = htmlElement.style.scrollBehavior;
  htmlElement.style.scrollBehavior = "auto";
  // Chromium only picks up the inline scroll-behavior change after a reflow.
  // https://github.com/vercel/next.js/issues/40719#issuecomment-1336248042
  htmlElement.getClientRects();
  try {
    fn();
  } finally {
    htmlElement.style.scrollBehavior = previousScrollBehavior;
  }
}
