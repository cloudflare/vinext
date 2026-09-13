import { describe, expect, it } from "vitest";
import { createAppBrowserNavigationAbortCoordinator } from "../packages/vinext/src/server/app-browser-navigation-abort.js";

describe("app browser navigation abort coordinator", () => {
  it("aborts transport work superseded by a newer navigation", () => {
    const coordinator = createAppBrowserNavigationAbortCoordinator();
    const first = coordinator.begin();

    coordinator.begin();

    expect(first.signal.aborted).toBe(true);
  });

  it("does not abort a Flight stream released after its response is accepted", () => {
    const coordinator = createAppBrowserNavigationAbortCoordinator();
    const first = coordinator.begin();
    first.release();

    coordinator.begin();

    expect(first.signal.aborted).toBe(false);
  });

  it("does not let a stale handle release the active navigation", () => {
    const coordinator = createAppBrowserNavigationAbortCoordinator();
    const first = coordinator.begin();
    const second = coordinator.begin();

    first.release();
    coordinator.abortActive();

    expect(second.signal.aborted).toBe(true);
  });
});
