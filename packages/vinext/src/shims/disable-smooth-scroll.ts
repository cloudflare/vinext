/**
 * Run a route-transition scroll with `scroll-behavior: auto` on `<html>`.
 *
 * Ported from Next.js:
 * packages/next/src/shared/lib/router/utils/disable-smooth-scroll.ts
 *
 * Since Next.js 16 (vercel/next.js#84102) the override is opt-in: it only
 * applies when the root element carries `data-scroll-behavior="smooth"`.
 * Without the attribute, a page-level `scroll-behavior: smooth` is respected
 * and route-change scrolls animate (development warns once about the missing
 * opt-in). Hash-only navigations never use this helper, so in-page anchor
 * jumps keep the smooth behavior.
 */
let warnedMissingDataScrollBehavior = false;

export function disableSmoothScrollDuringRouteTransition(fn: () => void): void {
  const htmlElement = document.documentElement;
  if (htmlElement.dataset.scrollBehavior !== "smooth") {
    if (
      process.env.NODE_ENV === "development" &&
      !warnedMissingDataScrollBehavior &&
      getComputedStyle(htmlElement).scrollBehavior === "smooth"
    ) {
      warnedMissingDataScrollBehavior = true;
      console.warn(
        "Detected `scroll-behavior: smooth` on the `<html>` element. To disable smooth scrolling during route transitions, " +
          'add `data-scroll-behavior="smooth"` to your <html> element. ' +
          "Learn more: https://nextjs.org/docs/messages/missing-data-scroll-behavior",
      );
    }
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
