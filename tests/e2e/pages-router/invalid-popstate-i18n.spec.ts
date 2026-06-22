import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { waitForHydration } from "../helpers";

const FIXTURE_DIR = `${process.cwd()}/tests/fixtures/pages-i18n-public-rewrite`;
const BASE_URL = "http://localhost:4191";

let server: ChildProcess;

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) {
      throw new Error(`i18n fixture server exited with code ${server.exitCode}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/sv/invalid-popstate/static`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for i18n fixture server");
}

type RouterHistoryState = {
  url: string;
  as: string;
  options: { locale: string };
  __N: true;
  key: string;
};

async function dispatchPopState(page: import("@playwright/test").Page, state: RouterHistoryState) {
  await page.evaluate((historyState) => {
    window.dispatchEvent(new PopStateEvent("popstate", { state: historyState }));
  }, state);
}

test.describe("invalid first popstate with i18n", () => {
  test.beforeAll(async () => {
    server = spawn(
      "created_node_modules=0; if ! test -e node_modules && ! test -L node_modules; then ln -s ../pages-basic/node_modules node_modules; created_node_modules=1; fi; trap 'if test \"$created_node_modules\" = 1; then rm node_modules; fi' EXIT; npx vp dev --port 4191",
      {
        cwd: FIXTURE_DIR,
        shell: true,
        stdio: "inherit",
      },
    );
    await waitForServer();
  });

  test.afterAll(async () => {
    server.kill();
  });

  for (const search of ["", "?param=1"]) {
    test(`ignores the first stale event for the active locale ${search || "without query"}`, async ({
      page,
    }) => {
      await page.goto(`${BASE_URL}/sv/invalid-popstate/static${search}`);
      await waitForHydration(page);

      const state: RouterHistoryState = {
        url: `/invalid-popstate/[dynamic]${search}`,
        as: `/invalid-popstate/static${search}`,
        options: { locale: "sv" },
        __N: true,
        key: "",
      };

      await expect(page.locator("#page-type")).toHaveText("static");
      await dispatchPopState(page, state);
      await page.waitForTimeout(100);
      await expect(page.locator("#page-type")).toHaveText("static");

      await dispatchPopState(page, state);
      await expect(page.locator("#page-type")).toHaveText("dynamic");
    });
  }

  test("does not ignore a stale event for another locale", async ({ page }) => {
    await page.goto(`${BASE_URL}/sv/invalid-popstate/static?param=1`);
    await waitForHydration(page);

    await dispatchPopState(page, {
      url: "/invalid-popstate/[dynamic]?param=1",
      as: "/invalid-popstate/static?param=1",
      options: { locale: "en" },
      __N: true,
      key: "",
    });

    await expect(page.locator("#page-type")).toHaveText("dynamic");
  });
});
