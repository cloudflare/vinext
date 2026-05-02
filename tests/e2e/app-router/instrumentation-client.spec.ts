// Ported from Next.js:
// test/e2e/instrumentation-client-hook/instrumentation-client-hook.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/instrumentation-client-hook/instrumentation-client-hook.test.ts

import { test, expect } from "@playwright/test";
import { promises as fs } from "node:fs";
import { waitForAppRouterHydration } from "../helpers";

const instrumentationClientPath = `${process.cwd()}/tests/fixtures/app-basic/instrumentation-client.ts`;

function filterNavigationStartLogs(logs: string[]): string[] {
  return logs.filter((message) => message.startsWith("[Router Transition Start]"));
}

test.describe.serial("instrumentation-client (App Router)", () => {
  test("executes instrumentation-client before hydration", async ({ page }) => {
    const logs: string[] = [];
    page.on("console", (message) => logs.push(message.text()));

    await page.goto("/instrumentation-client");
    await waitForAppRouterHydration(page);
    await page.waitForFunction(() => {
      const win = window as Window & {
        __INSTRUMENTATION_CLIENT_EXECUTED_AT?: number;
        __VINEXT_HYDRATED_AT?: number;
      };
      return (
        win.__INSTRUMENTATION_CLIENT_EXECUTED_AT !== undefined &&
        win.__VINEXT_HYDRATED_AT !== undefined
      );
    });

    const timing = await page.evaluate(() => {
      const win = window as Window & {
        __INSTRUMENTATION_CLIENT_EXECUTED_AT?: number;
        __VINEXT_HYDRATED_AT?: number;
      };
      return {
        instrumentation: win.__INSTRUMENTATION_CLIENT_EXECUTED_AT,
        hydration: win.__VINEXT_HYDRATED_AT,
      };
    });

    expect(timing.instrumentation).toBeDefined();
    expect(timing.hydration).toBeDefined();
    if (timing.instrumentation === undefined || timing.hydration === undefined) {
      throw new Error("Instrumentation or hydration timing marker was not recorded");
    }
    expect(timing.instrumentation).toBeLessThan(timing.hydration);
    expect(
      logs.some((message) =>
        message.startsWith("[Client Instrumentation Hook] Slow execution detected"),
      ),
    ).toBe(true);
  });

  test("onRouterTransitionStart fires at the start of push navigations", async ({ page }) => {
    const logs: string[] = [];
    page.on("console", (message) => logs.push(message.text()));

    await page.goto("/instrumentation-client");
    await waitForAppRouterHydration(page);
    await page.getByRole("link", { name: "Go to Some Page" }).click();
    await expect(page.locator("#instrumentation-client-some-page")).toBeVisible();
    await waitForAppRouterHydration(page);

    await page.getByRole("link", { name: "Go Home" }).click();
    await expect(page.locator("#instrumentation-client-home")).toBeVisible();
    await waitForAppRouterHydration(page);

    expect(filterNavigationStartLogs(logs)).toEqual([
      "[Router Transition Start] [push] /instrumentation-client/some-page",
      "[Router Transition Start] [push] /instrumentation-client",
    ]);
  });

  test("onRouterTransitionStart fires at the start of back/forward navigations", async ({
    page,
  }) => {
    const logs: string[] = [];
    page.on("console", (message) => logs.push(message.text()));

    await page.goto("/instrumentation-client");
    await waitForAppRouterHydration(page);
    await page.getByRole("link", { name: "Go to Some Page" }).click();
    await expect(page.locator("#instrumentation-client-some-page")).toBeVisible();
    await waitForAppRouterHydration(page);

    await page.goBack();
    await expect(page.locator("#instrumentation-client-home")).toBeVisible();
    await waitForAppRouterHydration(page);

    await page.goForward();
    await expect(page.locator("#instrumentation-client-some-page")).toBeVisible();
    await waitForAppRouterHydration(page);

    expect(filterNavigationStartLogs(logs)).toEqual([
      "[Router Transition Start] [push] /instrumentation-client/some-page",
      "[Router Transition Start] [traverse] /instrumentation-client",
      "[Router Transition Start] [traverse] /instrumentation-client/some-page",
    ]);
  });

  test("reloads instrumentation-client when modified in dev", async ({ page }) => {
    const originalContent = await fs.readFile(instrumentationClientPath, "utf8");

    try {
      await page.goto("/instrumentation-client");
      await waitForAppRouterHydration(page);
      await page.waitForFunction(() => {
        const win = window as Window & { __INSTRUMENTATION_CLIENT_EXECUTED_AT?: number };
        return win.__INSTRUMENTATION_CLIENT_EXECUTED_AT !== undefined;
      });

      const initialTime = await page.evaluate(() => {
        const win = window as Window & { __INSTRUMENTATION_CLIENT_EXECUTED_AT?: number };
        return win.__INSTRUMENTATION_CLIENT_EXECUTED_AT;
      });
      expect(initialTime).toBeDefined();

      await fs.writeFile(
        instrumentationClientPath,
        `${originalContent}\n(window as Window & { __INSTRUMENTATION_CLIENT_UPDATED?: boolean }).__INSTRUMENTATION_CLIENT_UPDATED = true;\n`,
      );

      await page.waitForFunction(() => {
        const win = window as Window & { __INSTRUMENTATION_CLIENT_UPDATED?: boolean };
        return win.__INSTRUMENTATION_CLIENT_UPDATED === true;
      });

      const newTime = await page.evaluate(() => {
        const win = window as Window & { __INSTRUMENTATION_CLIENT_EXECUTED_AT?: number };
        return win.__INSTRUMENTATION_CLIENT_EXECUTED_AT;
      });
      expect(newTime).toBeDefined();
      expect(newTime).not.toBe(initialTime);
    } finally {
      await fs.writeFile(instrumentationClientPath, originalContent);
    }
  });
});
