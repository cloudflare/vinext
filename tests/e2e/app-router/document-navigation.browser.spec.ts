import { expect, test } from "@playwright/test";
import { observeDocumentNavigationCancellation } from "../../../packages/vinext/src/server/app-browser-mpa-navigation.js";

// Browser EventTarget excludes listeners added during the current dispatch.
// Node's EventTarget invokes them, so this ownership edge needs a browser test.
test("an older navigation success cannot release a newer document attempt", async ({ page }) => {
  const result = await page.evaluate(async (source) => {
    // oxlint-disable-next-line no-eval -- Run the trusted helper source against browser EventTarget semantics.
    const observe = (0, eval)(`(${source})`) as typeof observeDocumentNavigationCancellation;
    const navigation = new EventTarget();
    let recoveries = 0;
    let latest: AbortController | undefined;
    const navigate = (url: string) => {
      const controller = new AbortController();
      navigation.dispatchEvent(
        Object.assign(new Event("navigate"), {
          destination: { url, sameDocument: false },
          signal: controller.signal,
        }),
      );
      return controller;
    };
    navigation.addEventListener(
      "navigatesuccess",
      () => {
        latest = navigate("https://example.com/latest");
      },
      { once: true },
    );
    observe(navigation, "https://example.com/first", () => {
      recoveries++;
    });
    navigate("https://example.com/first");
    navigation.dispatchEvent(new Event("navigatesuccess"));
    await Promise.resolve();
    const duringNewerNavigation = recoveries;
    latest!.abort();
    await Promise.resolve();
    return { duringNewerNavigation, afterCancellation: recoveries };
  }, observeDocumentNavigationCancellation.toString());
  expect(result).toEqual({ duringNewerNavigation: 0, afterCancellation: 1 });
});
