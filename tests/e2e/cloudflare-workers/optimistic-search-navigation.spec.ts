import { expect, test, type Page } from "@playwright/test";

const ROUTE = "/optimistic-search-navigation";
const DEPLOYED_RUNTIME = process.env.VINEXT_E2E_BASE_URL?.startsWith("https://") ?? false;

const providers = [
  { name: "netflix", value: "8" },
  { name: "prime", value: "9" },
  { name: "disney", value: "337" },
] as const;

async function markDocument(page: Page) {
  await page.locator("html").evaluate((element) => {
    element.dataset.optimisticNavigationDocument = "preserved";
  });
}

async function expectDocumentPreserved(page: Page) {
  await expect(page.locator("html")).toHaveAttribute(
    "data-optimistic-navigation-document",
    "preserved",
  );
}

async function expectProvider(page: Page, provider: string | null) {
  const expectedUrl = provider ? `${ROUTE}?provider=${provider}` : ROUTE;
  await expect(page).toHaveURL(expectedUrl);
  await expect(page.getByTestId("server-provider")).toHaveText(provider ?? "none");
  await expect(page.getByTestId("navigation-pending")).toHaveText("false");
  await expectDocumentPreserved(page);
}

test.describe("optimistic same-path search navigation", () => {
  test("router.push commits the server response without useOptimistic", async ({ page }) => {
    await page.goto(ROUTE);
    await markDocument(page);

    await page.getByTestId("router-only-control").click();

    await expect(page).toHaveURL(`${ROUTE}?provider=control`);
    await expect(page.getByTestId("server-provider")).toHaveText("control");
    await expectDocumentPreserved(page);
  });

  test("commits a provider selected inside a useOptimistic transition", async ({ page }) => {
    await page.goto(ROUTE);
    await markDocument(page);

    await page.getByTestId("provider-disney").click();

    await expect(page.getByTestId("client-provider")).toHaveText("337");
    await expectProvider(page, "337");
  });

  test("commits the final state when the active provider is toggled off", async ({ page }) => {
    await page.goto(`${ROUTE}?provider=8`);
    await expect(page.getByTestId("server-provider")).toHaveText("8");
    await markDocument(page);

    await page.getByTestId("provider-netflix").click();

    await expect(page.getByTestId("client-provider")).toHaveText("none");
    await expectProvider(page, null);
  });

  test("commits the last provider when transitions overlap", async ({ page }) => {
    await page.goto(ROUTE);
    await markDocument(page);

    await page.getByTestId("provider-netflix").click();
    await expect(page.getByTestId("client-provider")).toHaveText("8");
    await page.getByTestId("provider-disney").click();

    await expect(page.getByTestId("client-provider")).toHaveText("337");
    await expectProvider(page, "337");
  });

  test("commits repeated provider changes in a deployed Worker", async ({ page }) => {
    test.skip(!DEPLOYED_RUNTIME, "This race has only reproduced on a deployed Worker");
    test.setTimeout(120_000);

    await page.goto(ROUTE);
    await markDocument(page);

    for (let cycle = 0; cycle < 5; cycle += 1) {
      for (const provider of providers) {
        await page.getByTestId(`provider-${provider.name}`).click();
        await expectProvider(page, provider.value);

        await page.getByTestId(`provider-${provider.name}`).click();
        await expectProvider(page, null);
      }
    }
  });
});
