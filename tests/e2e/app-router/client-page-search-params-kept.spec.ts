import { expect, test, type Page } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = process.env.VINEXT_E2E_BASE_URL ?? "http://localhost:4174";
const KEPT = `${BASE}/client-page-search-params/kept`;

// The @panel client page is held back for 2s. /other has no @panel match, so
// a navigation there keeps the panel, and the page first renders under /other.
// It must still read the query of the response that delivered it.
async function keepPanelBeforeItRenders(page: Page, errors: string[]): Promise<void> {
  await expect(page.getByTestId("kept-client-page-fallback")).toBeVisible();
  await page.getByTestId("kept-client-page-other-link").click();
  await expect(page.getByTestId("kept-client-page-other")).toBeVisible();
  const tab = page.getByTestId("kept-client-page-tab");
  await expect(tab).toHaveCount(0);
  // Wait for the browser render: streamed SSR HTML can reveal the text first.
  await expect(tab).toHaveAttribute("data-hydrated", "true", { timeout: 10_000 });
  await expect(tab).toHaveText("hot");
  await expect(page).toHaveURL(/\/kept\/other$/);
  expect(errors).toEqual([]);
}

function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

test.beforeEach(async ({ request }) => {
  // Compile the routes first, so the navigations beat the delay.
  await request.get(`${KEPT}?tab=hot`);
  await request.get(`${KEPT}/other`);
  await request.get(`${BASE}/client-page-search-params/kept-start`);
});

test("a kept client page still streaming at hydration reads the query it was rendered with", async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await page.goto(`${KEPT}?tab=hot`, { waitUntil: "commit" });
  await waitForAppRouterHydration(page);
  await keepPanelBeforeItRenders(page, errors);
});

test("a kept client page still streaming after a navigation reads the query it was rendered with", async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await page.goto(`${BASE}/client-page-search-params/kept-start`);
  await waitForAppRouterHydration(page);
  await page.getByTestId("kept-client-page-start-link").click();
  await expect(page).toHaveURL(/\/kept\?tab=hot$/);
  await keepPanelBeforeItRenders(page, errors);
});
