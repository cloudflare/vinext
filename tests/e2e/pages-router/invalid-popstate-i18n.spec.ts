import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { waitForHydration } from "../helpers";

const FIXTURE_DIR = `${process.cwd()}/tests/fixtures/pages-i18n-public-rewrite`;
const PORT = process.env.VINEXT_E2E_I18N_PORT ?? "4191";
const BASE_URL = `http://localhost:${PORT}`;

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
      `created_node_modules=0; if ! test -e node_modules && ! test -L node_modules; then ln -s ../pages-basic/node_modules node_modules; created_node_modules=1; fi; trap 'if test "$created_node_modules" = 1; then rm node_modules; fi' EXIT; npx vp dev --port ${PORT}`,
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

  test("registers valid page loaders after a dev 404", async ({ page }) => {
    const response = await page.goto(`${BASE_URL}/sv/no-such-page`);
    expect(response?.status()).toBe(404);
    await waitForHydration(page);

    expect(
      await page.evaluate(async () => {
        const loaders = (
          window as typeof window & {
            __VINEXT_PAGE_LOADERS__: Record<string, () => Promise<{ default: unknown }>>;
            __VINEXT_PAGE_PATTERNS__: string[];
          }
        ).__VINEXT_PAGE_LOADERS__;
        return {
          hasPattern: (
            window as typeof window & { __VINEXT_PAGE_PATTERNS__: string[] }
          ).__VINEXT_PAGE_PATTERNS__.includes("/invalid-popstate/[dynamic]"),
          hasComponent:
            typeof (await loaders["/invalid-popstate/[dynamic]"]()).default === "function",
        };
      }),
    ).toEqual({ hasPattern: true, hasComponent: true });

    await page.evaluate(() => {
      (window as unknown as { __NAV_MARKER__: true }).__NAV_MARKER__ = true;
    });
    await page.evaluate(() => {
      const w = window as unknown as {
        next: { router: { push: (url: string, as: string) => Promise<boolean> } };
      };
      return w.next.router.push("/invalid-popstate/[dynamic]?dynamic=foo", "/invalid-popstate/foo");
    });
    await expect(page.locator("#page-type")).toHaveText("dynamic");
    expect(page.url()).toBe(`${BASE_URL}/sv/invalid-popstate/foo`);
    expect(
      await page.evaluate(() => (window as unknown as { __NAV_MARKER__?: true }).__NAV_MARKER__),
    ).toBe(true);
  });

  // Ported from Next.js: test/e2e/getserversideprops/test/index.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/getserversideprops/test/index.test.ts
  test("soft-renders custom _error after a notFound data response in dev", async ({ page }) => {
    await page.goto(`${BASE_URL}/sv/invalid-popstate/static`);
    await waitForHydration(page);
    await page.evaluate(() => {
      (window as typeof window & { __NAV_MARKER__?: boolean }).__NAV_MARKER__ = true;
    });

    await page.evaluate(() =>
      (
        window as unknown as { next: { router: { push(url: string): Promise<boolean> } } }
      ).next.router.push("/gssp-not-found"),
    );

    await expect(page.locator("#custom-error")).toHaveText("Custom Pages error");
    expect(page.url()).toBe(`${BASE_URL}/sv/gssp-not-found`);
    expect(
      await page.evaluate(
        () => (window as typeof window & { __NAV_MARKER__?: boolean }).__NAV_MARKER__,
      ),
    ).toBe(true);
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
