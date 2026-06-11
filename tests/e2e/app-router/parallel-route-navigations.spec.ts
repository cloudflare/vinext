// Ported from Next.js:
// test/e2e/app-dir/parallel-route-navigations/parallel-route-navigations.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/parallel-route-navigations/parallel-route-navigations.test.ts

import { expect, test, type Page } from "@playwright/test";
import { setTimeout } from "node:timers/promises";
import { waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174";
const SLOT_FILE = "/parallel-route-navigations/[teamID]/@slot/[...catchAll]/page.tsx";

async function expectStable(action: () => Promise<void>, stableForMs = 1_000): Promise<void> {
  await expect(action).toPass({ timeout: 3_000 });

  for (let index = 0; index < 10; index++) {
    await action();
    await setTimeout(stableForMs / 10);
  }
}

async function readJsonAttribute(
  page: Page,
  selector: string,
  attribute: string,
): Promise<unknown> {
  const value = await page.locator(selector).getAttribute(attribute);
  expect(value).not.toBeNull();
  return JSON.parse(value ?? "null");
}

async function expectSlotParams(
  page: Page,
  expected: { teamID: string; catchAll: string[] },
): Promise<void> {
  const clientSelector = `[data-client-file="${SLOT_FILE}"][data-client-params]`;
  const serverSelector = `[data-server-file="${SLOT_FILE}"][data-server-params]`;

  await expect(readJsonAttribute(page, clientSelector, "data-client-params")).resolves.toEqual(
    expected,
  );
  await expect(readJsonAttribute(page, serverSelector, "data-server-params")).resolves.toEqual(
    expected,
  );
}

test.describe("parallel-route-navigations", () => {
  test("should render the right parameters on the server", async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();

    try {
      await page.goto(`${BASE}/parallel-route-navigations/vercel/sub/folder`);

      await expectSlotParams(page, {
        teamID: "vercel",
        catchAll: ["sub", "folder"],
      });
    } finally {
      await context.close();
    }
  });

  test("should render the right parameters on client navigations", async ({ page }) => {
    await page.goto(`${BASE}/parallel-route-navigations/vercel/sub/folder`);
    await waitForAppRouterHydration(page);

    await expectSlotParams(page, {
      teamID: "vercel",
      catchAll: ["sub", "folder"],
    });

    await page.locator('a[href="/parallel-route-navigations/vercel/sub/other-folder"]').click();

    await expectStable(async () => {
      await expectSlotParams(page, {
        teamID: "vercel",
        catchAll: ["sub", "other-folder"],
      });
    });
  });
});
