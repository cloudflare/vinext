/**
 * Regression tests for the `useLinkStatus()` pending registry (issue #1527).
 *
 * The registry tracks the single <Link> driving the most recent App Router
 * navigation so its pending state can be cleared when a *different* navigation
 * begins. These tests reproduce the upstream
 * `test/e2e/use-link-status/index.test.ts` scenarios at the registry level —
 * the part vinext got wrong, where a Link's pending flag stayed "sticky" after
 * an interrupting navigation (multi-click, router.push, shallow routing,
 * browser back) settled.
 */
import { describe, it, expect, beforeEach } from "vite-plus/test";
import {
  clearLinkForCurrentNavigation,
  notifyLinkNavigationStart,
  setLinkForCurrentNavigation,
  type PendingLinkSetter,
} from "../packages/vinext/src/shims/internal/link-status-registry.js";

// Reset module state between tests by clearing whatever link is tracked.
beforeEach(() => {
  // Two notifications guarantee any in-flight link-initiated marker is consumed
  // and the tracked setter is cleared, leaving a clean registry.
  notifyLinkNavigationStart();
  notifyLinkNavigationStart();
});

/** Build a fake <Link> pending setter that records the latest value it saw. */
function createPendingLink(): { setter: PendingLinkSetter; pending: () => boolean } {
  let pending = false;
  return {
    setter: (next: boolean) => {
      pending = next;
    },
    pending: () => pending,
  };
}

describe("link-status registry", () => {
  it("keeps the link that initiated the navigation pending", () => {
    const link = createPendingLink();
    // <Link> click: register itself, then show pending.
    setLinkForCurrentNavigation(link.setter);
    link.setter(true);
    // navigateClientSide fires the navigation-start hook synchronously.
    notifyLinkNavigationStart();
    expect(link.pending()).toBe(true);
  });

  it("clears the previous link when a different link is clicked (multi-click)", () => {
    const post1 = createPendingLink();
    const post2 = createPendingLink();

    // Click post 1.
    setLinkForCurrentNavigation(post1.setter);
    post1.setter(true);
    notifyLinkNavigationStart();
    expect(post1.pending()).toBe(true);

    // Quickly click post 2 — post 1's pending must clear, post 2 becomes pending.
    setLinkForCurrentNavigation(post2.setter);
    post2.setter(true);
    notifyLinkNavigationStart();

    expect(post1.pending()).toBe(false);
    expect(post2.pending()).toBe(true);
  });

  it("clears a sticky pending link when navigation starts by router.push", () => {
    const link = createPendingLink();

    setLinkForCurrentNavigation(link.setter);
    link.setter(true);
    notifyLinkNavigationStart();
    expect(link.pending()).toBe(true);

    // router.push goes through navigateClientSide without registering a link,
    // so the navigation-start hook resets the previously-pending link.
    notifyLinkNavigationStart();
    expect(link.pending()).toBe(false);
  });

  it("clears a sticky pending link on a programmatic navigation (shallow routing / back)", () => {
    const link = createPendingLink();

    setLinkForCurrentNavigation(link.setter);
    link.setter(true);
    notifyLinkNavigationStart();
    expect(link.pending()).toBe(true);

    // A raw history.pushState (shallow routing) or popstate (back) fires the
    // navigation-start hook with no link registered.
    notifyLinkNavigationStart();
    expect(link.pending()).toBe(false);
  });

  it("does not call into an unmounted link after clearLinkForCurrentNavigation", () => {
    const link = createPendingLink();
    let calls = 0;
    const trackingSetter: PendingLinkSetter = (next) => {
      calls += 1;
      link.setter(next);
    };

    setLinkForCurrentNavigation(trackingSetter);
    trackingSetter(true);
    notifyLinkNavigationStart(); // consumes the link-initiated marker
    const callsAfterClick = calls;

    // Link unmounts (or finishes its own navigation): drop it from the registry.
    clearLinkForCurrentNavigation(trackingSetter);

    // A later programmatic navigation must not invoke the dropped setter.
    notifyLinkNavigationStart();
    expect(calls).toBe(callsAfterClick);
  });

  it("only resets the tracked link, not an unrelated one", () => {
    const tracked = createPendingLink();
    const unrelated = createPendingLink();
    unrelated.setter(true); // pending but never registered

    setLinkForCurrentNavigation(tracked.setter);
    tracked.setter(true);
    notifyLinkNavigationStart();

    // Programmatic navigation clears only the tracked link.
    notifyLinkNavigationStart();
    expect(tracked.pending()).toBe(false);
    expect(unrelated.pending()).toBe(true);
  });
});
