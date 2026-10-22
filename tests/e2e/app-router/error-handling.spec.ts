import { test, expect } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174";

test.describe("Error Boundaries", () => {
  test("global-error preserves server and SSR client error semantics after hydration", async ({
    page,
  }) => {
    await page.goto(`${BASE}/nextjs-compat/global-error-rsc`);
    await expect(page.locator('[data-testid="global-error-message"]')).toContainText(
      "server page error",
    );
    await expect(page.locator('[data-testid="global-error-digest"]')).not.toBeEmpty();

    await page.goto(`${BASE}/nextjs-compat/global-error-ssr`);
    await expect(page.locator('[data-testid="global-error-message"]')).toHaveText(
      "client page error",
    );
    await expect(page.locator('[data-testid="global-error-digest"]')).toHaveCount(0);
  });

  test("error.tsx catches client component error on button click", async ({ page }) => {
    await page.goto(`${BASE}/error-test`);

    // Page renders normally first
    await expect(page.locator('[data-testid="error-content"]')).toBeVisible();

    // Wait for hydration — the button must be interactive
    const button = page.locator('[data-testid="trigger-error"]');
    await expect(button).toBeVisible();
    await page.waitForTimeout(1000); // Give React time to hydrate

    // Click the button that triggers an error
    await button.click();

    // Error boundary should render
    await expect(page.locator("#error-boundary")).toBeVisible({
      timeout: 5000,
    });
    await expect(page.locator("#error-boundary p")).toContainText(
      "Test error from client component",
    );
  });

  test("error.tsx renders reset button", async ({ page }) => {
    await page.goto(`${BASE}/error-test`);

    const button = page.locator('[data-testid="trigger-error"]');
    await expect(button).toBeVisible();
    await page.waitForTimeout(1000);

    // Trigger error
    await button.click();

    // Error boundary shows reset button
    await expect(page.locator("#error-boundary")).toBeVisible({
      timeout: 5000,
    });
    const resetButton = page.locator("#error-boundary button");
    await expect(resetButton).toHaveText("Try again");
  });

  test("error.tsx catches falsy values thrown by client components", async ({ page }) => {
    // Ported from Next.js: test/e2e/app-dir/errors/index.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/errors/index.test.ts
    const cases = [
      ["undefined", "undefined"],
      ["null", "null"],
      ["zero", "0"],
      ["empty-string", ""],
      ["false", "false"],
    ] satisfies readonly (readonly [string, string])[];

    for (const [name, expectedText] of cases) {
      await page.goto(`${BASE}/falsy-error-boundary-test`);
      await expect(page.locator('[data-testid="falsy-error-content"]')).toBeVisible();
      const trigger = page.locator(`[data-testid="throw-${name}"]`);
      await expect(trigger).toBeEnabled();
      await trigger.click();
      await expect(page.locator('[data-testid="falsy-error-boundary"]')).toBeVisible({
        timeout: 5000,
      });
      await expect(page.locator('[data-testid="falsy-error-message"]')).toHaveText(expectedText);
    }
  });

  test("server component error renders error.tsx boundary with 200", async ({ page }) => {
    const response = await page.goto(`${BASE}/error-server-test`);
    // Next.js returns 200 when error.tsx catches an error (it's "handled")
    expect(response?.status()).toBe(200);
    await expect(page.locator('[data-testid="server-error-boundary"]')).toBeVisible();
    await expect(page.locator('[data-testid="server-error-message"]')).toContainText(
      "Server component error",
    );
  });

  test("nested server component error renders child error.tsx boundary", async ({ page }) => {
    const response = await page.goto(`${BASE}/error-nested-test/child`);
    expect(response?.status()).toBe(200);
    // Should render the child's error.tsx, not the parent's
    await expect(page.locator('[data-testid="inner-error-boundary"]')).toBeVisible();
    await expect(page.locator('[data-testid="inner-error-message"]')).toContainText(
      "Nested child error",
    );
  });

  test("parent route without error renders normally", async ({ page }) => {
    await page.goto(`${BASE}/error-nested-test`);

    await expect(page.locator('[data-testid="error-nested-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="outer-error-boundary"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="inner-error-boundary"]')).not.toBeVisible();
  });
});

test.describe("Not Found", () => {
  test("unknown route returns 404", async ({ page }) => {
    const response = await page.goto(`${BASE}/this-route-does-not-exist`);
    expect(response?.status()).toBe(404);
  });

  test("notFound() renders custom not-found.tsx", async ({ page }) => {
    await page.goto(`${BASE}/notfound-test`);
    // The notfound-test page calls notFound() unconditionally
    const response = await page.goto(`${BASE}/notfound-test`);
    expect(response?.status()).toBe(404);
    await expect(page.locator("h1")).toContainText("404");
  });

  // https://github.com/cloudflare/vinext/issues/4092
  test("client-side notFound() renders an ancestor not-found in place of the layouts below it", async ({
    page,
  }) => {
    await page.goto(`${BASE}/nextjs-compat/not-found-ancestor-boundary`);
    await waitForAppRouterHydration(page);
    // A full page load would render the document fallback instead.
    await page.evaluate(() => {
      (window as Window & { __clientNavMarker?: boolean }).__clientNavMarker = true;
    });

    await page.getByRole("link", { name: "Missing" }).click();
    await expect(page.locator("#not-found-ancestor-boundary-nf")).toBeVisible();
    await expect(page.locator("#not-found-ancestor-boundary-layout")).toBeVisible();
    await expect(page.locator("#not-found-ancestor-boundary-section")).toHaveCount(0);

    // A sibling under the same child layout clears the fallback.
    await page.getByRole("link", { name: "Present" }).click();
    await expect(page.locator("#not-found-ancestor-boundary-page")).toHaveText(
      "Section page: present",
    );
    await expect(page.locator("#not-found-ancestor-boundary-section")).toBeVisible();
    await expect(page.locator("#not-found-ancestor-boundary-nf")).toHaveCount(0);

    // The section layout owns no boundary, and its state survives siblings
    // whose nearest not-found file differs while the owner's reset key changes.
    const counter = page.locator("#not-found-ancestor-boundary-counter");
    await counter.click();
    await counter.click();
    await expect(counter).toHaveText("count:2");
    await page.getByRole("link", { name: "Own" }).click();
    await expect(page.locator("#not-found-ancestor-boundary-own")).toBeVisible();
    await expect(counter).toHaveText("count:2");
    await page.getByRole("link", { name: "Present" }).click();
    await expect(page.locator("#not-found-ancestor-boundary-page")).toBeVisible();
    await expect(counter).toHaveText("count:2");

    expect(
      await page.evaluate(
        () => (window as Window & { __clientNavMarker?: boolean }).__clientNavMarker,
      ),
    ).toBe(true);
  });

  test("a notFound() streamed after the shell renders the ancestor not-found in place of the layouts below it", async ({
    page,
  }) => {
    const response = await page.goto(
      `${BASE}/nextjs-compat/not-found-ancestor-boundary/section/slow`,
      { waitUntil: "commit" },
    );
    // The document streamed the loading shell, so the server's not-found
    // render never ran and the client boundary placed the fallback.
    expect(response?.status()).toBe(200);
    expect(await response?.text()).toContain("not-found-ancestor-boundary-loading");
    await expect(page.locator("#not-found-ancestor-boundary-nf")).toBeVisible();
    await expect(page.locator("#not-found-ancestor-boundary-layout")).toBeVisible();
    await expect(page.locator("#not-found-ancestor-boundary-section")).toHaveCount(0);
  });

  test("a slot navigation keeps the preserved children page mounted", async ({ page }) => {
    // /slots owns its not-found.tsx beside the page; the /slots/settings slot
    // route sees it as an ancestor layout's file. The page-level boundary
    // above the preserved children page must keep its type across the two.
    await page.goto(`${BASE}/nextjs-compat/not-found-ancestor-boundary/slots`);
    await waitForAppRouterHydration(page);
    await expect(page.locator("#not-found-ancestor-boundary-team")).toBeVisible();
    const counter = page.locator("#not-found-ancestor-boundary-slots-counter");
    await counter.click();
    await counter.click();
    await expect(counter).toHaveText("count:2");

    await page.getByRole("link", { name: "Slot settings" }).click();
    await expect(page.locator("#not-found-ancestor-boundary-team-settings")).toBeVisible();
    await expect(counter).toHaveText("count:2");

    await page.getByRole("link", { name: "Slots home" }).click();
    await expect(page.locator("#not-found-ancestor-boundary-team")).toBeVisible();
    await expect(counter).toHaveText("count:2");
  });

  // https://github.com/cloudflare/vinext/issues/4092
  test("client-side notFound() renders a not-found from a segment without a layout", async ({
    page,
  }) => {
    await page.goto(`${BASE}/nextjs-compat/not-found-layout-segment/en/shop/hello`);
    await waitForAppRouterHydration(page);
    await page.evaluate(() => {
      (window as Window & { __clientNavMarker?: boolean }).__clientNavMarker = true;
    });
    const counter = page.locator("#not-found-layout-segment-counter");
    await counter.click();
    await counter.click();
    await expect(counter).toHaveText("count:2");

    // [lang]/not-found.tsx replaces the shop layout, inside the layout above.
    await page.getByRole("link", { name: "Gone" }).click();
    await expect(page.locator("#not-found-layout-segment-nf")).toBeVisible();
    await expect(page.locator("#not-found-layout-segment-shop")).toHaveCount(0);
    await expect(counter).toHaveText("count:2");

    // A sibling whose nearest not-found file differs clears the fallback.
    await page.getByRole("link", { name: "Item", exact: true }).click();
    await expect(page.locator("#not-found-layout-segment-page")).toHaveText("Item: hello");
    await expect(page.locator("#not-found-layout-segment-nf")).toHaveCount(0);
    await expect(counter).toHaveText("count:2");

    expect(
      await page.evaluate(
        () => (window as Window & { __clientNavMarker?: boolean }).__clientNavMarker,
      ),
    ).toBe(true);
  });

  // https://github.com/cloudflare/vinext/issues/4045
  test("a layout's notFound() below a loading.tsx renders the segment boundary above it", async ({
    page,
  }) => {
    const response = await page.goto(
      `${BASE}/nextjs-compat/not-found-layout-segment/en/slow/invalid`,
      { waitUntil: "commit" },
    );
    // Layouts below a loading.tsx are not probed, so the document streamed the
    // loading shell and the [lang] boundary in the tree caught the signal.
    expect(response?.status()).toBe(200);
    expect(await response?.text()).toContain("not-found-layout-segment-loading");
    await expect(page.locator("#not-found-layout-segment-nf")).toBeVisible();
    await expect(page.locator("#not-found-layout-segment-layout")).toBeVisible();
    await expect(page.locator("#not-found-layout-segment-slow")).toHaveCount(0);

    // The same signal on a client navigation lands on the same boundary.
    await waitForAppRouterHydration(page);
    await page.getByRole("link", { name: "Item", exact: true }).click();
    await expect(page.locator("#not-found-layout-segment-page")).toHaveText("Item: hello");
    await page.getByRole("link", { name: "Slow", exact: true }).click();
    await expect(page.locator("#not-found-layout-segment-nf")).toBeVisible();
    await expect(page.locator("#not-found-layout-segment-slow")).toHaveCount(0);

    // Like Next.js, the boundary clears when the pathname changes, even when
    // only the throwing layout's own param does.
    await page.getByRole("link", { name: "Slow item" }).click();
    await expect(page.locator("#not-found-layout-segment-slow")).toBeVisible();
    await expect(page.locator("#not-found-layout-segment-nf")).toHaveCount(0);
  });

  test("an intercepted modal's notFound() clears when the modal navigates to another photo", async ({
    page,
  }) => {
    await page.goto(`${BASE}/nextjs-compat/not-found-intercept-reset/feed`);
    await waitForAppRouterHydration(page);
    await page.evaluate(() => {
      (window as Window & { __clientNavMarker?: boolean }).__clientNavMarker = true;
    });

    // The modal's signal leaves the feed layout, so the segment's not-found
    // replaces it.
    await page.getByRole("link", { name: "Missing photo" }).click();
    await expect(page.locator("#not-found-intercept-reset-nf")).toBeVisible();
    await expect(page.locator("#not-found-intercept-reset-feed")).toHaveCount(0);

    // Still intercepted from the feed, the next photo keeps the source route.
    // Like Next.js, the boundary clears because the visible pathname changed.
    await page.getByRole("link", { name: "Photo 1" }).click();
    await expect(page).toHaveURL(/\/not-found-intercept-reset\/feed\/photo\/1$/);
    await expect(page.locator("#not-found-intercept-reset-modal")).toHaveText("Photo modal: 1");
    await expect(page.locator("#not-found-intercept-reset-feed-page")).toBeVisible();
    await expect(page.locator("#not-found-intercept-reset-nf")).toHaveCount(0);

    expect(
      await page.evaluate(
        () => (window as Window & { __clientNavMarker?: boolean }).__clientNavMarker,
      ),
    ).toBe(true);
  });

  test("a sibling intercepting page's notFound() renders the not-found beside it", async ({
    page,
  }) => {
    await page.goto(`${BASE}/nextjs-compat/not-found-sibling-intercept`);
    await waitForAppRouterHydration(page);
    await page.evaluate(() => {
      (window as Window & { __clientNavMarker?: boolean }).__clientNavMarker = true;
    });

    // Like Next.js, the intercepting route's own not-found catches the signal
    // inside its layout, ahead of the source segment's not-found.
    await page.getByRole("link", { name: "Missing item" }).click();
    await expect(page).toHaveURL(/\/not-found-sibling-intercept\/item\/missing$/);
    await expect(page.locator("#not-found-sibling-intercept-intercept-nf")).toBeVisible();
    await expect(
      page.locator(
        "#not-found-sibling-intercept-intercept-layout #not-found-sibling-intercept-intercept-nf",
      ),
    ).toBeVisible();
    await expect(page.locator("#not-found-sibling-intercept-source-nf")).toHaveCount(0);

    // It clears when the intercepted navigation moves on to another item.
    await page.getByRole("link", { name: "Item 1" }).click();
    await expect(page.locator("#not-found-sibling-intercept-intercepted")).toHaveText(
      "Intercepted item: 1",
    );
    await expect(page.locator("#not-found-sibling-intercept-intercept-nf")).toHaveCount(0);

    expect(
      await page.evaluate(
        () => (window as Window & { __clientNavMarker?: boolean }).__clientNavMarker,
      ),
    ).toBe(true);
  });

  test("a sibling intercepting page's generateMetadata() notFound() renders the not-found beside it", async ({
    page,
  }) => {
    await page.goto(`${BASE}/nextjs-compat/not-found-sibling-intercept`);
    await waitForAppRouterHydration(page);

    // Next.js renders the page's metadata outlet inside the page segment, so
    // the intercepting route's own not-found catches its generateMetadata().
    await page.getByRole("link", { name: "Metadata not found" }).click();
    await expect(page).toHaveURL(/\/not-found-sibling-intercept\/item\/metadata-missing$/);
    await expect(
      page.locator(
        "#not-found-sibling-intercept-intercept-layout #not-found-sibling-intercept-intercept-nf",
      ),
    ).toBeVisible();
    await expect(page.locator("#not-found-sibling-intercept-source-nf")).toHaveCount(0);
  });

  test("a parallel slot's notFound() renders the same boundary in the document and on navigation", async ({
    page,
  }) => {
    // Next.js attaches not-found boundaries only to each segment's `children`,
    // so the [lang] boundary above the team layout catches the @members slot's
    // signal, not the route's deepest boundary (team/not-found.tsx).
    const response = await page.goto(`${BASE}/nextjs-compat/not-found-layout-segment/en/team`);
    expect(response?.status()).toBe(404);
    await expect(page.locator("#not-found-layout-segment-nf")).toBeVisible();
    await expect(page.locator("#not-found-layout-segment-layout")).toBeVisible();
    await expect(page.locator("#not-found-layout-segment-team")).toHaveCount(0);
    await expect(page.locator("#not-found-layout-segment-team-nf")).toHaveCount(0);

    await page.goto(`${BASE}/nextjs-compat/not-found-layout-segment/en/shop/hello`);
    await waitForAppRouterHydration(page);
    await page.getByRole("link", { name: "Team", exact: true }).click();
    await expect(page.locator("#not-found-layout-segment-nf")).toBeVisible();
    await expect(page.locator("#not-found-layout-segment-team")).toHaveCount(0);
    await expect(page.locator("#not-found-layout-segment-team-nf")).toHaveCount(0);
  });

  test("a parallel slot's layout notFound() renders the same boundary in the document and on navigation", async ({
    page,
  }) => {
    // The slot's layout throws above its own not-found.tsx and inside the crew
    // layout, so the [lang] boundary above the crew layout catches it.
    const response = await page.goto(`${BASE}/nextjs-compat/not-found-layout-segment/en/crew`);
    expect(response?.status()).toBe(404);
    await expect(page.locator("#not-found-layout-segment-nf")).toBeVisible();
    await expect(page.locator("#not-found-layout-segment-layout")).toBeVisible();
    await expect(page.locator("#not-found-layout-segment-crew")).toHaveCount(0);
    await expect(page.locator("#not-found-layout-segment-crew-nf")).toHaveCount(0);
    await expect(page.locator("#not-found-layout-segment-roles-nf")).toHaveCount(0);

    await page.goto(`${BASE}/nextjs-compat/not-found-layout-segment/en/shop/hello`);
    await waitForAppRouterHydration(page);
    await page.getByRole("link", { name: "Crew", exact: true }).click();
    await expect(page.locator("#not-found-layout-segment-nf")).toBeVisible();
    await expect(page.locator("#not-found-layout-segment-crew")).toHaveCount(0);
    await expect(page.locator("#not-found-layout-segment-crew-nf")).toHaveCount(0);
    await expect(page.locator("#not-found-layout-segment-roles-nf")).toHaveCount(0);
  });
});

test.describe("Forbidden & Unauthorized", () => {
  test("forbidden() returns 403 status", async ({ page }) => {
    const response = await page.goto(`${BASE}/forbidden-test`);
    expect(response?.status()).toBe(403);
  });

  test("unauthorized() returns 401 status", async ({ page }) => {
    const response = await page.goto(`${BASE}/unauthorized-test`);
    expect(response?.status()).toBe(401);
  });
});
