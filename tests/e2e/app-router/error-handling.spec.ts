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

  test("server component error renders error.tsx boundary with 500", async ({ page }) => {
    const response = await page.goto(`${BASE}/error-server-test`);
    // Next.js answers 500 when the error rejects the document's shell, even
    // when error.tsx catches it. Only an error streamed after the shell keeps 200.
    expect(response?.status()).toBe(500);
    await expect(page.locator('[data-testid="server-error-boundary"]')).toBeVisible();
    await expect(page.locator('[data-testid="server-error-message"]')).toContainText(
      "Server component error",
    );
  });

  test("nested server component error renders child error.tsx boundary", async ({ page }) => {
    const response = await page.goto(`${BASE}/error-nested-test/child`);
    expect(response?.status()).toBe(500);
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

  test("notFound() from a component a layout renders is caught above that layout", async ({
    page,
  }) => {
    // The document fails before streaming, so it answers with the boundary
    // above the guarded layout, not the one beside its page.
    const response = await page.goto(
      `${BASE}/nextjs-compat/not-found-layout-segment/en/guard/gone`,
    );
    expect(response?.status()).toBe(404);
    await expect(page.locator("#not-found-layout-segment-nf")).toBeVisible();
    await expect(page.locator("#not-found-layout-segment-layout")).toBeVisible();
    await expect(page.locator("#not-found-layout-segment-guard")).toHaveCount(0);
    await expect(page.locator("#not-found-layout-segment-guard-nf")).toHaveCount(0);

    await waitForAppRouterHydration(page);
    await page.getByRole("link", { name: "Guard pass" }).click();
    await expect(page.locator("#not-found-layout-segment-guard-page")).toHaveText(
      "Guarded item: hello",
    );
    await expect(page.locator("#not-found-layout-segment-guard-ok")).toBeVisible();
    const counter = page.locator("#not-found-layout-segment-counter");
    await counter.click();
    await expect(counter).toHaveText("count:1");

    // A client navigation lands on the same boundary, keeping the layout above.
    await page.getByRole("link", { name: "Guard fail" }).click();
    await expect(page.locator("#not-found-layout-segment-nf")).toBeVisible();
    await expect(page.locator("#not-found-layout-segment-guard")).toHaveCount(0);
    await expect(page.locator("#not-found-layout-segment-guard-nf")).toHaveCount(0);
    await expect(counter).toHaveText("count:1");
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

  test("a sibling intercepting layout's notFound() reaches the source segment's not-found", async ({
    page,
  }) => {
    await page.goto(`${BASE}/nextjs-compat/not-found-sibling-intercept`);
    await waitForAppRouterHydration(page);

    // The (.)item/[id] layout's signal skips the not-found inside it, and with
    // none above it in the intercepting route, Next.js renders the source
    // segment's not-found in place of the intercepting route.
    await page.getByRole("link", { name: "Layout not found" }).click();
    await expect(page).toHaveURL(/\/not-found-sibling-intercept\/item\/layout-missing$/);
    await expect(
      page.locator("#not-found-sibling-intercept-layout #not-found-sibling-intercept-source-nf"),
    ).toBeVisible();
    await expect(page.locator("#not-found-sibling-intercept-intercept-layout")).toHaveCount(0);
    await expect(page.locator("#not-found-sibling-intercept-intercept-nf")).toHaveCount(0);

    // It clears when the intercepted navigation moves on to another item.
    await page.getByRole("link", { name: "Item 1" }).click();
    await expect(page.locator("#not-found-sibling-intercept-intercepted")).toHaveText(
      "Intercepted item: 1",
    );
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

  test("a parallel slot's own not-found catches its notFound() inside the slot on navigation", async ({
    page,
  }) => {
    await page.goto(`${BASE}/nextjs-compat/not-found-slot-own/team/ok`);
    await waitForAppRouterHydration(page);
    await expect(page.locator("#slot-own-team")).toHaveText("Team ok");

    // Like Next.js, the @team slot's not-found.tsx catches its page's signal,
    // and the route's layout and page keep rendering beside it.
    await page.getByRole("link", { name: "Team missing" }).click();
    await expect(page).toHaveURL(/\/team\/missing$/);
    await expect(page.locator("#slot-own-team-slot #slot-own-team-nf")).toBeVisible();
    await expect(page.locator("#slot-own-main")).toBeVisible();
    await expect(page.locator("#slot-own-segment-nf")).toHaveCount(0);
    await expect(page.locator("#slot-own-root-nf")).toHaveCount(0);

    // A nested slot page without its own file is caught by the slot root's.
    await page.getByRole("link", { name: "Members missing" }).click();
    await expect(page).toHaveURL(/\/team\/missing\/members$/);
    await expect(page.locator("#slot-own-main-members")).toBeVisible();
    await expect(page.locator("#slot-own-team-slot #slot-own-team-nf")).toBeVisible();
    await expect(page.locator("#slot-own-root-nf")).toHaveCount(0);

    // A nested slot layout's own notFound() skips the not-found inside it and
    // reaches the slot root's.
    await page.getByRole("link", { name: "Roster missing" }).click();
    await expect(page).toHaveURL(/\/team\/missing\/roster$/);
    await expect(page.locator("#slot-own-main-roster")).toBeVisible();
    await expect(page.locator("#slot-own-team-slot #slot-own-team-nf")).toBeVisible();
    await expect(page.locator("#slot-own-roster-nf")).toHaveCount(0);
    await expect(page.locator("#slot-own-segment-nf")).toHaveCount(0);

    // It clears when the slot renders again.
    await page.getByRole("link", { name: "Team ok" }).click();
    await expect(page.locator("#slot-own-team")).toHaveText("Team ok");
    await expect(page.locator("#slot-own-team-nf")).toHaveCount(0);
  });

  test("a parallel slot's own not-found catches its notFound() inside the slot in the document", async ({
    page,
    request,
  }) => {
    // Next.js sends a 404 error shell and renders the slot's own not-found in
    // the browser, beside the rest of the route. The document renders it.
    for (const [path, mainId] of [
      ["team/missing", "slot-own-main"],
      // A nested slot page without its own file is caught by the slot root's.
      ["team/missing/members", "slot-own-main-members"],
      // A nested slot layout's own notFound() skips the not-found inside it.
      ["team/missing/roster", "slot-own-main-roster"],
    ]) {
      const response = await request.get(`${BASE}/nextjs-compat/not-found-slot-own/${path}`);
      expect(response.status(), path).toBe(404);
      const html = await response.text();
      expect(html, path).toContain('id="slot-own-team-nf"');
      expect(html, path).toContain(`id="${mainId}"`);
      expect(html, path).toContain('<meta name="robots" content="noindex"');
      expect(html, path).not.toContain('id="slot-own-segment-nf"');
      expect(html, path).not.toContain('id="slot-own-root-nf"');
      expect(html, path).not.toContain('id="slot-own-roster-nf"');
    }

    const errors: string[] = [];
    page.on("console", (message) => {
      // The browser logs the document's own 404.
      if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) {
        errors.push(message.text());
      }
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${BASE}/nextjs-compat/not-found-slot-own/team/missing`);
    await waitForAppRouterHydration(page);
    await expect(page.locator("#slot-own-team-slot #slot-own-team-nf")).toBeVisible();
    await expect(page.locator("#slot-own-main")).toBeVisible();
    // The boundary hydrates caught, so React doesn't recover by client rendering.
    expect(errors).toEqual([]);

    // It clears when the slot renders again, and doesn't stick on a later visit.
    await page.getByRole("link", { name: "Team ok" }).click();
    await expect(page.locator("#slot-own-team")).toHaveText("Team ok");
    await expect(page.locator("#slot-own-team-nf")).toHaveCount(0);
    await page.getByRole("link", { name: "Members missing" }).click();
    await expect(page.locator("#slot-own-team-slot #slot-own-team-nf")).toBeVisible();
    await page.goBack();
    await expect(page.locator("#slot-own-team")).toHaveText("Team ok");
  });

  test("a parallel slot's default.tsx notFound() skips the slot's own not-found", async ({
    page,
  }) => {
    // Next.js renders an unmatched slot as a `__DEFAULT__` segment without the
    // slot directory's files, so @panel/not-found.tsx doesn't catch it and the
    // not-found above the panel layout does.
    const response = await page.goto(`${BASE}/nextjs-compat/not-found-slot-own/panel`);
    expect(response?.status()).toBe(404);
    await waitForAppRouterHydration(page);
    await expect(page.locator("#slot-own-layout #slot-own-root-nf")).toBeVisible();
    await expect(page.locator("#slot-own-panel-layout")).toHaveCount(0);
    await expect(page.locator("#slot-own-panel-nf")).toHaveCount(0);
    await expect(page.locator("#slot-own-panel-segment-nf")).toHaveCount(0);
    // Like Next.js once its error shell hydrates, the title is the route's own,
    // not a not-found's.
    await expect(page).toHaveTitle("Slot own layout");

    await page.goto(`${BASE}/nextjs-compat/not-found-slot-own`);
    await waitForAppRouterHydration(page);
    await page.getByRole("link", { name: "Panel default" }).click();
    await expect(page).toHaveURL(/\/panel$/);
    await expect(page.locator("#slot-own-layout #slot-own-root-nf")).toBeVisible();
    await expect(page.locator("#slot-own-panel-layout")).toHaveCount(0);
    await expect(page.locator("#slot-own-panel-nf")).toHaveCount(0);
    await expect(page.locator("#slot-own-panel-segment-nf")).toHaveCount(0);
    await expect(page).toHaveTitle("Slot own layout");
  });

  test("a page's and a slot's notFound() keep the layout rendering the slot", async ({ page }) => {
    // The team segment's not-found catches the page's inside the team layout,
    // and the slot's own not-found catches the slot's. "late" throws the
    // page's from below a Suspense boundary.
    const errors: string[] = [];
    page.on("console", (message) => {
      // The browser logs the document's own 404.
      if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) {
        errors.push(message.text());
      }
    });
    page.on("pageerror", (error) => errors.push(error.message));
    for (const id of ["both", "late"]) {
      const response = await page.goto(`${BASE}/nextjs-compat/not-found-slot-own/team/${id}`);
      expect(response?.status(), id).toBe(404);
      await waitForAppRouterHydration(page);
      await expect(page.locator("#slot-own-team-layout #slot-own-segment-nf")).toBeVisible();
      await expect(page.locator("#slot-own-team-slot #slot-own-team-nf")).toBeVisible();
      await expect(page.locator("#slot-own-root-nf")).toHaveCount(0);
      // The route's own title, where Turbopack's slot page's wins over the
      // page's, never a not-found's.
      await expect(page, id).toHaveTitle("Team slot page");
    }
    // Both boundaries hydrate caught, so React doesn't recover by client rendering.
    expect(errors).toEqual([]);

    await page.goto(`${BASE}/nextjs-compat/not-found-slot-own/team/ok`);
    await waitForAppRouterHydration(page);
    await expect(page).toHaveTitle("Team slot page");
    for (const id of ["both", "late"]) {
      await page.getByRole("link", { name: `Team ${id}` }).click();
      await expect(page).toHaveURL(new RegExp(`/team/${id}$`));
      await expect(page.locator("#slot-own-team-layout #slot-own-segment-nf")).toBeVisible();
      await expect(page.locator("#slot-own-team-slot #slot-own-team-nf")).toBeVisible();
      await expect(page.locator("#slot-own-root-nf")).toHaveCount(0);
      await expect(page, id).toHaveTitle("Team slot page");
    }
  });

  test("a layout's or a template's notFound() beside a slot's is caught above that layout", async ({
    page,
  }) => {
    const cases = [
      { link: "Team gone", path: "team/gone", layout: "#slot-own-team-layout" },
      { link: "Template", path: "tmpl", layout: "#slot-own-tmpl-layout" },
    ];
    for (const { path, layout } of cases) {
      const response = await page.goto(`${BASE}/nextjs-compat/not-found-slot-own/${path}`);
      expect(response?.status(), path).toBe(404);
      await waitForAppRouterHydration(page);
      await expect(page.locator("#slot-own-layout #slot-own-root-nf")).toBeVisible();
      await expect(page.locator(layout)).toHaveCount(0);
    }

    for (const { link, path, layout } of cases) {
      await page.goto(`${BASE}/nextjs-compat/not-found-slot-own/team/ok`);
      await waitForAppRouterHydration(page);
      await page.getByRole("link", { name: link, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/${path}$`));
      await expect(page.locator("#slot-own-layout #slot-own-root-nf")).toBeVisible();
      await expect(page.locator(layout)).toHaveCount(0);
    }
  });

  test("a slot intercept below a slot segment keeps that segment's layout and not-found", async ({
    page,
  }) => {
    await page.goto(`${BASE}/nextjs-compat/not-found-slot-own/team/ok/roster`);
    await waitForAppRouterHydration(page);

    await page.getByRole("link", { name: "Player missing" }).click();
    await expect(page).toHaveURL(/\/team\/ok\/roster\/player\/missing$/);
    await expect(
      page.locator("#slot-own-team-slot #slot-own-roster-layout #slot-own-roster-nf"),
    ).toBeVisible();
    await expect(page.locator("#slot-own-team-nf")).toHaveCount(0);

    await page.getByRole("link", { name: "Player ok" }).click();
    await expect(page.locator("#slot-own-roster-layout #slot-own-roster-player")).toHaveText(
      "Player ok",
    );
    await expect(page.locator("#slot-own-roster-nf")).toHaveCount(0);
  });

  test("an intercepting modal's own not-found catches its notFound() inside the modal", async ({
    page,
  }) => {
    await page.goto(`${BASE}/nextjs-compat/not-found-slot-own`);
    await waitForAppRouterHydration(page);

    await page.getByRole("link", { name: "Item missing" }).click();
    await expect(page).toHaveURL(/\/item\/missing$/);
    await expect(page.locator("#slot-own-modal #slot-own-modal-nf")).toBeVisible();
    // The source page stays behind the modal.
    await expect(page.locator("#slot-own-home")).toBeVisible();
    await expect(page.locator("#slot-own-root-nf")).toHaveCount(0);
    // Like Next.js, a slot intercept keeps the source route's title.
    await expect(page).toHaveTitle("Slot own layout");

    await page.getByRole("link", { name: "Item ok" }).click();
    await expect(page.locator("#slot-own-modal-item")).toHaveText("Modal item ok");
    await expect(page.locator("#slot-own-modal-nf")).toHaveCount(0);
    await expect(page).toHaveTitle("Slot own layout");

    // The intercepted route's own document uses its page's title.
    await page.goto(`${BASE}/nextjs-compat/not-found-slot-own/item/ok`);
    await waitForAppRouterHydration(page);
    await expect(page).toHaveTitle("Item page");
  });

  test("an intercepting modal's generateMetadata() notFound() renders its own not-found inside the modal", async ({
    page,
  }) => {
    // Next.js 16.2.7 renders the MetadataOutlet in the intercepting page's
    // segment, so the signal stays inside the modal beside the source page.
    await page.goto(`${BASE}/nextjs-compat/not-found-slot-own`);
    await waitForAppRouterHydration(page);

    await page.getByRole("link", { name: "Item metadata missing" }).click();
    await expect(page).toHaveURL(/\/item\/meta-missing$/);
    await expect(page.locator("#slot-own-modal #slot-own-modal-nf")).toBeVisible();
    await expect(page.locator("#slot-own-home")).toBeVisible();
    await expect(page.locator("#slot-own-root-nf")).toHaveCount(0);
    await expect(page).toHaveTitle("Slot own layout");
  });

  for (const kind of ["forbidden", "unauthorized"]) {
    test(`an intercepting modal's generateMetadata() ${kind}() renders its own ${kind} inside the modal`, async ({
      page,
    }) => {
      // Next.js 16.2.7 (Turbopack) catches it in the intercepting page's own
      // segment too, with the source page and its title kept.
      await page.goto(`${BASE}/nextjs-compat/not-found-slot-own`);
      await waitForAppRouterHydration(page);

      await page.getByRole("link", { name: `Item metadata ${kind}` }).click();
      await expect(page).toHaveURL(new RegExp(`/item/meta-${kind}$`));
      await expect(page.locator(`#slot-own-modal #slot-own-modal-${kind}`)).toBeVisible();
      await expect(page.locator("#slot-own-home")).toBeVisible();
      await expect(page).toHaveTitle("Slot own layout");
    });
  }

  test("an intercepting modal's generateMetadata() error renders its own segment's error.tsx inside the modal", async ({
    page,
  }) => {
    // Next.js renders the MetadataOutlet in the intercepting page's segment,
    // under that segment's error boundary: @modal/(.)item/[id]/error.tsx.
    await page.goto(`${BASE}/nextjs-compat/not-found-slot-own`);
    await waitForAppRouterHydration(page);

    await page.getByRole("link", { name: "Item metadata error" }).click();
    await expect(page).toHaveURL(/\/item\/meta-error$/);
    await expect(page.locator("#slot-own-modal #slot-own-modal-error")).toBeVisible();
    await expect(page.locator("#slot-own-home")).toBeVisible();
  });

  test("a slot intercept with no page before its slot takes the intercepting page's title", async ({
    page,
  }) => {
    // Next.js 16.2.7 (Turbopack) titles this navigation by the intercept:
    // its head walk skips `children`, which renders nothing here.
    await page.goto(`${BASE}/nextjs-compat/slot-only-intercept/first`);
    await waitForAppRouterHydration(page);
    await expect(page).toHaveTitle("Slot only first");

    await page.getByRole("link", { name: "Photo" }).click();
    await expect(page).toHaveURL(/\/slot-only-intercept\/photo$/);
    await expect(page.locator("#slot-only-bar-intercept")).toBeVisible();
    await expect(page).toHaveTitle("Slot only photo intercept");
  });

  for (const { boundary, kind } of [
    { boundary: "nf", kind: "missing" },
    { boundary: "forbidden", kind: "forbidden" },
    { boundary: "unauthorized", kind: "unauthorized" },
  ]) {
    test(`a heading slot intercept's generateMetadata() ${kind} signal renders its own boundary in the slot`, async ({
      page,
    }) => {
      // Next.js 16.2.7 (Turbopack) throws the signal in the intercepting page's
      // segment, so its own not-found, forbidden or unauthorized file renders
      // inside the slot, the layout stays, and the layouts title the page.
      await page.goto(`${BASE}/nextjs-compat/slot-only-intercept/first`);
      await waitForAppRouterHydration(page);

      await page.getByRole("link", { name: `Signal ${kind}` }).click();
      await expect(page).toHaveURL(new RegExp(`/slot-only-intercept/signal/${kind}$`));
      await expect(
        page.locator(`#slot-only-layout #slot-only-bar #slot-only-bar-signal-${boundary}`),
      ).toBeVisible();
      await expect(page.locator("#slot-only-bar-signal")).toHaveCount(0);
      await expect(page).toHaveTitle("Slot only layout");
    });
  }
});

test.describe("Forbidden & Unauthorized", () => {
  for (const { kind, link } of [
    { kind: "forbidden", link: "Forbidden item" },
    { kind: "unauthorized", link: "Unauthorized item" },
  ]) {
    test(`a sibling intercepting page's ${kind}() renders the ${kind} beside it`, async ({
      page,
    }) => {
      await page.goto(`${BASE}/nextjs-compat/not-found-sibling-intercept`);
      await waitForAppRouterHydration(page);

      // Like Next.js, the intercepting route's own boundary catches the signal
      // inside its layout, ahead of the source segment's.
      await page.getByRole("link", { name: link }).click();
      await expect(page).toHaveURL(new RegExp(`/not-found-sibling-intercept/item/${kind}$`));
      await expect(
        page.locator(
          `#not-found-sibling-intercept-intercept-layout #not-found-sibling-intercept-intercept-${kind}`,
        ),
      ).toBeVisible();
      await expect(page.locator(`#not-found-sibling-intercept-source-${kind}`)).toHaveCount(0);
    });
  }

  test("forbidden() returns 403 status", async ({ page }) => {
    const response = await page.goto(`${BASE}/forbidden-test`);
    expect(response?.status()).toBe(403);
  });

  test("unauthorized() returns 401 status", async ({ page }) => {
    const response = await page.goto(`${BASE}/unauthorized-test`);
    expect(response?.status()).toBe(401);
  });
});
