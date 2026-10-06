import type { NavigationRuntimeVisibleCommitMode } from "../client/navigation-runtime.js";

/**
 * A settled prefetch carries already-decoded elements, so its commit is
 * upgraded to a synchronous (flushSync) render. Run inside the initiating
 * click or router.push() task, that render is charged to the interaction's
 * next paint (INP). Next.js avoids this by dispatching navigations inside
 * React.startTransition, so its click handler returns before rendering.
 *
 * Only ordinary navigations whose commit vinext upgrades yield. Traversals
 * restore scroll in the same commit and are not input-driven, and an
 * explicitly synchronous commit (gesture push) keeps its own timing.
 */
export function shouldYieldBeforePreparedPrefetchCommit(options: {
  hasPreparedElements: boolean;
  navigationKind: "navigate" | "traverse" | "refresh";
  visibleCommitMode: NavigationRuntimeVisibleCommitMode;
}): boolean {
  return (
    options.hasPreparedElements &&
    options.navigationKind === "navigate" &&
    options.visibleCommitMode === "transition"
  );
}

// Cap on the wait for a frame. Offscreen or display:none cross-origin iframes
// stay "visible" but Chromium stops running their animation frames, so an
// embedded app's navigation must not depend on one arriving.
const PAINT_YIELD_TIMEOUT_MS = 100;

/**
 * Resolves once the browser has had the chance to present the frame for the
 * triggering input. requestAnimationFrame runs just before that frame's paint;
 * the posted message runs as a task after it. The frame path uses a message
 * instead of setTimeout so the yield also completes under fake or frozen
 * timers.
 *
 * The yield never holds a navigation for long: it is skipped when the document
 * is hidden, abandoned if the document is hidden while waiting, and bounded by
 * a short timer for documents that are visible but not producing frames.
 */
export function waitForNextPaint(): Promise<void> {
  if (
    typeof requestAnimationFrame !== "function" ||
    typeof cancelAnimationFrame !== "function" ||
    typeof MessageChannel !== "function" ||
    document.visibilityState === "hidden"
  ) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const finish = () => {
      clearTimeout(timer);
      // A frame-suppressed document may never run this callback; cancel it so
      // the fallbacks release the closure and channel.
      cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", finish);
      channel.port1.onmessage = null;
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    const timer = setTimeout(finish, PAINT_YIELD_TIMEOUT_MS);
    channel.port1.onmessage = finish;
    document.addEventListener("visibilitychange", finish);
    const frame = requestAnimationFrame(() => channel.port2.postMessage(null));
  });
}
