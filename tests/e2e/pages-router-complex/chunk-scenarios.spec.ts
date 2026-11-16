import { test, expect } from "@playwright/test";

type MediaWindow = Window & { __ATLAS_MEDIA_INLINE__?: boolean };
type EvaluationWindow = Window & { __WORKBENCH_EVALUATIONS__?: string[] };

/**
 * The workbench desks exist to give production builds a varied client chunk
 * graph: modules shared by different subsets of pages, a shared module above
 * 20 kB, `_app`-shared helpers, local vendor packages (side-effect-free
 * barrel, CommonJS, a CSS module), next/dynamic, React.lazy, nested and
 * on-demand imports, and the page-only next/image, next/script, next/form
 * and next/navigation runtimes. These specs check that every one of those
 * pieces still loads and hydrates, whatever the chunking.
 */
test.describe("workbench chunk scenarios", () => {
  for (const desk of ["ledger", "roster", "dispatch", "inventory"]) {
    test(`${desk} desk hydrates its shared panels`, async ({ page }) => {
      await page.goto(`/workbench/${desk}`);
      await expect(page.locator(`[data-desk="${desk}"]`)).toHaveAttribute("data-hydrated", "true");

      const pill = page.getByTestId(`status-pill-${desk}`);
      await expect(pill).toHaveAttribute("data-tone", "idle");

      await pill.click();
      await expect(pill).toHaveAttribute("data-tone", "busy");
    });
  }

  test("shared filter bar drives roster and dispatch", async ({ page }) => {
    await page.goto("/workbench/roster");
    await expect(page.locator('[data-desk="roster"]')).toHaveAttribute("data-hydrated", "true");

    await page.getByTestId("filter-select").selectOption("south");
    await expect(page.getByTestId("roster-shifts")).toHaveAttribute("data-crew", "south");
    await expect(page.getByTestId("roster-shifts").locator("li")).toHaveCount(1);
    await expect(page.getByTestId("roster-shifts")).toContainText("SH-0012");

    await page.goto("/workbench/dispatch");
    await expect(page.locator('[data-desk="dispatch"]')).toHaveAttribute("data-hydrated", "true");

    await page.getByTestId("filter-select").selectOption("Harbor Gate");
    await expect(page.getByTestId("dispatch-regions")).toHaveAttribute("data-hub", "Harbor Gate");
  });

  test("export menu loads the CSV encoder on demand", async ({ page }) => {
    await page.goto("/workbench/inventory");
    await expect(page.locator('[data-desk="inventory"]')).toHaveAttribute("data-hydrated", "true");
    await expect(page.getByTestId("inventory-table").locator("tbody tr")).toHaveCount(4);

    await page.getByTestId("export-csv").click();
    await expect(page.getByTestId("export-output")).toContainText("R001,40 units");
  });

  test("reports load next/dynamic, ssr:false, React.lazy and nested lazy chunks", async ({
    page,
  }) => {
    const response = await page.request.get("/workbench/reports");
    const html = await response.text();

    // next/dynamic with SSR and React.lazy both render on the server.
    expect(html).toContain('data-testid="trend-chart"');
    expect(html).toContain('data-testid="breakdown-table"');
    expect(html).toContain('data-testid="live-ticker-loading"');

    await page.goto("/workbench/reports");
    await expect(page.locator('[data-desk="reports"]')).toHaveAttribute("data-hydrated", "true");
    await expect(page.getByTestId("live-ticker")).toBeVisible();
    await expect(page.getByTestId("trend-legend").locator("li")).toHaveCount(5);

    const pill = page.getByTestId("status-pill-breakdown");
    await pill.click();
    await expect(pill).toHaveAttribute("data-tone", "busy");
  });

  test("tools load JSON and a lazy-only module on click", async ({ page }) => {
    await page.goto("/workbench/tools");
    await expect(page.locator('[data-desk="tools"]')).toHaveAttribute("data-hydrated", "true");
    await expect(page.getByTestId("tools-csv")).toContainText("diff,ready");

    await page.getByTestId("load-presets").click();
    await expect(page.getByTestId("presets").locator("li")).toHaveCount(3);

    await page.getByTestId("run-diff").click();
    await expect(page.getByTestId("diff-output")).toHaveText("+20m -30m");
  });

  test("media desk runs next/image and next/script", async ({ page }) => {
    await page.goto("/workbench/media");
    await expect(page.locator('[data-desk="media"]')).toHaveAttribute("data-hydrated", "true");
    await expect(page.getByTestId("media-swatch")).toBeVisible();

    await expect
      .poll(() => page.evaluate(() => (window as MediaWindow).__ATLAS_MEDIA_INLINE__))
      .toBe(true);
  });

  test("search desk reads next/navigation and submits next/form", async ({ page }) => {
    await page.goto("/workbench/search?q=amber");
    await expect(page.locator('[data-desk="search"]')).toHaveAttribute("data-hydrated", "true");
    await expect(page.getByTestId("search-term")).toHaveText("amber");

    await page.getByTestId("search-input").fill("cedar");
    await page.getByTestId("search-input").press("Enter");
    await page.waitForURL("**/workbench/search?q=cedar");
    await expect(page.getByTestId("search-term")).toHaveText("cedar");
  });

  test("a module several desks share evaluates once, and only where it is imported", async ({
    page,
  }) => {
    const evaluations = () =>
      page.evaluate(() => (window as EvaluationWindow).__WORKBENCH_EVALUATIONS__ ?? []);

    await page.goto("/workbench");
    await expect(page.locator('[data-desk="hub"]')).toHaveAttribute("data-hydrated", "true");
    expect(await evaluations()).toEqual([]);

    for (const desk of ["ledger", "roster", "inventory"]) {
      await page.getByTestId(`desk-link-${desk}`).click();
      await expect(page.locator(`[data-desk="${desk}"]`)).toHaveAttribute("data-hydrated", "true");
      expect(await evaluations()).toEqual(["status-pill"]);
    }
  });

  test("client navigation visits every desk without a document load", async ({ page }) => {
    await page.goto("/workbench");
    await expect(page.locator('[data-desk="hub"]')).toHaveAttribute("data-hydrated", "true");

    await page.evaluate(() => {
      (window as Window & { __workbench_marker__?: boolean }).__workbench_marker__ = true;
    });

    for (const desk of [
      "ledger",
      "roster",
      "dispatch",
      "inventory",
      "reports",
      "tools",
      "media",
      "search",
    ]) {
      await page.getByTestId(`desk-link-${desk}`).click();
      await expect(page.locator(`[data-desk="${desk}"]`)).toHaveAttribute("data-hydrated", "true");
    }

    expect(
      await page.evaluate(
        () => (window as Window & { __workbench_marker__?: boolean }).__workbench_marker__,
      ),
    ).toBe(true);
  });
});
