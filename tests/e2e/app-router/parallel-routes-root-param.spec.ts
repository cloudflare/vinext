import { expect, test } from "@playwright/test";

// Ported from Next.js:
// test/e2e/app-dir/parallel-routes-root-param-dynamic-child/parallel-routes-root-param-dynamic-child.test.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/parallel-routes-root-param-dynamic-child/parallel-routes-root-param-dynamic-child.test.ts

test.describe("parallel routes under a static root param", () => {
  for (const locale of ["en", "fr"]) {
    test(`keeps child params dynamic for generated locale ${locale}`, async ({ page }) => {
      const response = await page.goto(`/parallel-root-param/${locale}/no-gsp/stories/dynamic-123`);

      expect(response?.status()).toBe(200);
      await expect(page.getByTestId("parallel-root-story")).toHaveText(
        `Story: ${locale}/dynamic-123`,
      );
      await expect(page.getByTestId("parallel-root-breadcrumb")).toHaveText(
        `Breadcrumb: ${locale}/dynamic-123`,
      );
    });
  }

  test("rejects an unknown root param with a valid generated leaf", async ({ request }) => {
    expect((await request.get("/parallel-root-param/es/gsp/stories/static-123")).status()).toBe(
      404,
    );
  });

  test("keeps child params dynamic during soft navigation", async ({ page }) => {
    await page.goto("/parallel-root-param/en");
    await page.getByRole("link", { name: "Dynamic child" }).click();

    await expect(page).toHaveURL(/\/parallel-root-param\/es\/no-gsp\/stories\/dynamic-123$/);
    await expect(page.getByTestId("parallel-root-story")).toHaveText("Story: es/dynamic-123");
    await expect(page.getByTestId("parallel-root-breadcrumb")).toHaveText(
      "Breadcrumb: es/dynamic-123",
    );
  });

  test("enforces generated child params from a parallel layout", async ({ page }) => {
    expect((await page.goto("/parallel-root-param/en/gsp/stories/static-123"))?.status()).toBe(200);
    await expect(page.getByTestId("parallel-root-story")).toHaveText("Story: en/static-123");
    await expect(page.getByTestId("parallel-root-breadcrumb")).toHaveText(
      "Breadcrumb: en/static-123",
    );

    expect((await page.goto("/parallel-root-param/en/gsp/stories/dynamic-123"))?.status()).toBe(
      404,
    );
  });

  test("renders the 404 boundary for an unknown generated child during soft navigation", async ({
    page,
  }) => {
    await page.goto("/parallel-root-param/en");
    await page.getByRole("link", { name: "Unknown static child" }).click();

    await expect(page).toHaveURL(/\/parallel-root-param\/en\/gsp\/stories\/dynamic-123$/);
    await expect(page.getByText("This page could not be found", { exact: true })).toBeVisible();
  });

  test("enforces generated params on the root page", async ({ request }) => {
    expect((await request.get("/parallel-root-param/en")).status()).toBe(200);
    expect((await request.get("/parallel-root-param/es")).status()).toBe(404);
  });
});
