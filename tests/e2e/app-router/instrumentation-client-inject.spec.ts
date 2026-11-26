// Ported from Next.js:
// test/e2e/instrumentation-client-hook/instrumentation-client-hook.test.ts
// ("instrumentationClientInject" > "surfaces onRouterTransitionStart from every
// injected module" and "isolates hook errors between injected modules")
// https://github.com/vercel/next.js/blob/v16.4.6/test/e2e/instrumentation-client-hook/instrumentation-client-hook.test.ts

import { test, expect } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

test("instrumentationClientInject hooks are read at transition time and isolated", async ({
  page,
}) => {
  const logs: string[] = [];
  page.on("console", (message) => logs.push(message.text()));

  await page.goto("/instrumentation-client");
  await waitForAppRouterHydration(page);
  await page.evaluate(() => {
    const win = window as Window & {
      __VINEXT_INSTALL_LATE_INSTRUMENTATION_HOOK?: () => void;
      __VINEXT_THROW_INJECTED_HOOK?: boolean;
    };
    win.__VINEXT_INSTALL_LATE_INSTRUMENTATION_HOOK?.();
    win.__VINEXT_THROW_INJECTED_HOOK = true;
  });

  await page.getByRole("link", { name: "Go to Some Page" }).click();
  await expect(page.locator("#instrumentation-client-some-page")).toBeVisible();

  expect(
    logs.filter(
      (message) =>
        message.startsWith("[Injected Transition Start]") ||
        message.startsWith("[Router Transition Start]"),
    ),
  ).toEqual([
    "[Injected Transition Start] [push] /instrumentation-client/some-page late-hook null",
    "[Injected Transition Start] [push] /instrumentation-client/some-page throws",
    "[Router Transition Start] [push] /instrumentation-client/some-page",
  ]);
  expect(
    logs.filter((message) =>
      message.includes("An instrumentation-client router transition hook failed"),
    ),
  ).toHaveLength(1);
});
