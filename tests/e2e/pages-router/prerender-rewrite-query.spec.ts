import { test, expect, type Page } from "@playwright/test";

async function expectHydratedQuery(
  page: Page,
  url: string,
  expectedParams: unknown,
  expectedInitialQuery: unknown,
  expectedQuery: unknown,
) {
  const hydrationErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && /hydration|did not match/i.test(message.text())) {
      hydrationErrors.push(message.text());
    }
  });

  await page.goto(url);
  await expect
    .poll(async () => JSON.parse(await page.locator("#params").innerText()))
    .toEqual(expectedParams);
  await expect
    .poll(async () => JSON.parse(await page.locator("#query").innerText()))
    .toEqual(expectedQuery);
  expect(await page.evaluate(() => (window as any).__NEXT_DATA__.query)).toEqual(
    expectedInitialQuery,
  );
  expect(hydrationErrors).toEqual([]);
}

async function expectHashNavigationPreservesQuery(
  page: Page,
  url: string,
  expectedQuery: unknown,
  mode: "push" | "replace",
) {
  await page.goto(url);
  await expect
    .poll(async () => JSON.parse(await page.locator("#query").innerText()))
    .toEqual(expectedQuery);

  await page.evaluate(async (navigationMode) => {
    await (window as any).next.router[navigationMode]("#after-hydration");
  }, mode);

  await expect(page).toHaveURL(/#after-hydration$/);
  await expect
    .poll(async () => JSON.parse(await page.locator("#query").innerText()))
    .toEqual(expectedQuery);
}

async function expectBackForwardRestoresQuery(page: Page, url: string, expectedQuery: unknown) {
  await page.goto(url);
  await expect
    .poll(async () => JSON.parse(await page.locator("#query").innerText()))
    .toEqual(expectedQuery);

  await page.evaluate(async () => {
    await (window as any).next.router.push("/about");
  });
  await expect(page).toHaveURL(/\/about$/);

  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`${new URL(url, "http://localhost").pathname}.*$`));
  await expect
    .poll(async () => JSON.parse(await page.locator("#query").innerText()))
    .toEqual(expectedQuery);

  await page.goForward();
  await expect(page).toHaveURL(/\/about$/);
  await page.goBack();
  await expect
    .poll(async () => JSON.parse(await page.locator("#query").innerText()))
    .toEqual(expectedQuery);
}

async function expectClientNavigationPreservesServerQuery(
  page: Page,
  url: string,
  expectedQuery: unknown,
  mode: "push" | "replace",
) {
  await page.goto("/about");
  await page.evaluate(
    async ({ navigationMode, target }) => {
      await (window as any).next.router[navigationMode](target);
    },
    { navigationMode: mode, target: url },
  );

  await expect(page).toHaveURL(new RegExp(`${new URL(url, "http://localhost").pathname}.*$`));
  await expect
    .poll(async () => JSON.parse(await page.locator("#query").innerText()))
    .toEqual(expectedQuery);
}

test.describe("Pages prerender rewrite query", () => {
  test("preserves destination query for static GSP hydration", async ({ page }) => {
    await expectHydratedQuery(
      page,
      "/prerender-rewrite?visible=browser&same=visible",
      {},
      { same: "destination", from: "config" },
      { visible: "browser", same: "destination", from: "config" },
    );
  });

  test("preserves destination query with encoded dynamic params", async ({ page }) => {
    await expectHydratedQuery(
      page,
      "/prerender-rewrite-dynamic/a%2Fb?visible=browser&same=visible",
      { slug: "a/b" },
      { same: "destination", from: "config", slug: "a/b" },
      { visible: "browser", same: "destination", from: "config", slug: "a/b" },
    );
  });

  test("preserves destination query with absent optional params", async ({ page }) => {
    await expectHydratedQuery(
      page,
      "/prerender-rewrite-optional?visible=browser&same=visible",
      {},
      { same: "destination", from: "config" },
      { visible: "browser", same: "destination", from: "config" },
    );
  });

  test("preserves destination query for a same-path config rewrite", async ({ page }) => {
    await expectHydratedQuery(
      page,
      "/prerender-query-same?visible=browser&same=visible",
      {},
      { same: "destination", from: "config" },
      { visible: "browser", same: "destination", from: "config" },
    );
  });

  test("preserves destination query for a dynamic same-path config rewrite", async ({ page }) => {
    await expectHydratedQuery(
      page,
      "/prerender-query-same-dynamic/a%2Fb?visible=browser&same=visible",
      { slug: "a/b" },
      { same: "destination", from: "config", slug: "a/b" },
      { visible: "browser", same: "destination", from: "config", slug: "a/b" },
    );
  });

  test("does not resurrect visible query removed by middleware", async ({ page }) => {
    await expectHydratedQuery(
      page,
      "/prerender-middleware-clear?allowed=kept&removed=visible",
      {},
      {},
      { allowed: "kept" },
    );
  });

  for (const mode of ["push", "replace"] as const) {
    test(`preserves static same-path rewrite query after client ${mode}`, async ({ page }) => {
      await expectClientNavigationPreservesServerQuery(
        page,
        "/prerender-query-same?visible=client&same=visible",
        { visible: "client", same: "destination", from: "config" },
        mode,
      );
    });

    test(`preserves dynamic same-path rewrite query after client ${mode}`, async ({ page }) => {
      await expectClientNavigationPreservesServerQuery(
        page,
        "/prerender-query-same-dynamic/a%2Fb?visible=client&same=visible",
        { visible: "client", same: "destination", from: "config", slug: "a/b" },
        mode,
      );
    });

    test(`keeps middleware-cleared query removed after client ${mode}`, async ({ page }) => {
      await expectClientNavigationPreservesServerQuery(
        page,
        "/prerender-middleware-clear?allowed=kept&removed=visible",
        { allowed: "kept" },
        mode,
      );
    });

    test(`preserves same-path rewrite query after hash-only ${mode}`, async ({ page }) => {
      await expectHashNavigationPreservesQuery(
        page,
        "/prerender-query-same?visible=browser&same=visible",
        { visible: "browser", same: "destination", from: "config" },
        mode,
      );
    });

    test(`does not resurrect middleware-removed query after hash-only ${mode}`, async ({
      page,
    }) => {
      await expectHashNavigationPreservesQuery(
        page,
        "/prerender-middleware-clear?allowed=kept&removed=visible",
        { allowed: "kept" },
        mode,
      );
    });
  }

  test("restores same-path rewrite query across back and forward", async ({ page }) => {
    await expectBackForwardRestoresQuery(
      page,
      "/prerender-query-same?visible=browser&same=visible",
      { visible: "browser", same: "destination", from: "config" },
    );
  });

  test("keeps middleware-removed query cleared across back and forward", async ({ page }) => {
    await expectBackForwardRestoresQuery(
      page,
      "/prerender-middleware-clear?allowed=kept&removed=visible",
      { allowed: "kept" },
    );
  });

  test("switches to browser query authority after a real page navigation", async ({ page }) => {
    await page.goto("/prerender-query-same?visible=initial&same=visible");
    await page.evaluate(async () => {
      await (window as any).next.router.push("/prerender-rewrite?visible=client&same=visible");
    });

    await expect(page).toHaveURL(/\/prerender-rewrite\?visible=client&same=visible$/);
    await expect
      .poll(async () => JSON.parse(await page.locator("#query").innerText()))
      .toEqual({ visible: "client", same: "destination", from: "config" });
  });

  test("trusts server query metadata over a spoofed GSSP header", async ({ page }) => {
    await page.goto("/about");
    await page.evaluate(async () => {
      await (window as any).next.router.push(
        "/prerender-query-gssp?__proto__=first&__proto__=second&tag=a&tag=b",
      );
    });

    await expect
      .poll(async () => JSON.parse(await page.locator("#query").innerText()))
      .toEqual(JSON.parse('{"__proto__":["first","second"],"tag":["a","b"]}'));
  });
});
