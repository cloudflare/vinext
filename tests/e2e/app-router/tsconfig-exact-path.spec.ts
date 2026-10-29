import { test, expect, type Page } from "@playwright/test";

// app-basic's tsconfig maps the exact key `fake-tsconfig-exact-lib` to the
// package's src/index.js. TypeScript and Next.js match a key without `*` only
// against the exact specifier, so `fake-tsconfig-exact-lib/runtime` resolves
// through the package's `exports` instead of `src/index.js/runtime`.
const ENTRY = "entry from tsconfig paths";
const RUNTIME = "runtime from package exports";

async function expectHydratedClient(page: Page) {
  await expect(page.getByTestId("client")).toHaveAttribute("data-hydrated", "true");
  await expect(page.getByTestId("client-entry")).toHaveText(ENTRY);
  await expect(page.getByTestId("client-runtime")).toHaveText(RUNTIME);
}

test.describe("exact tsconfig paths keys", () => {
  test("App Router resolves only the exact specifier through tsconfig paths", async ({
    page,
    request,
  }) => {
    const response = await request.get("/tsconfig-exact-path");
    expect(response.status()).toBe(200);
    const html = (await response.text()).replaceAll("<!-- -->", "");
    expect(html).toContain(`<p data-testid="server-entry">${ENTRY}</p>`);
    expect(html).toContain(`<p data-testid="server-runtime">${RUNTIME}</p>`);
    expect(html).toContain(`<p data-testid="client-entry">${ENTRY}</p>`);
    expect(html).toContain(`<p data-testid="client-runtime">${RUNTIME}</p>`);

    await page.goto("/tsconfig-exact-path");
    await expect(page.getByTestId("server-entry")).toHaveText(ENTRY);
    await expect(page.getByTestId("server-runtime")).toHaveText(RUNTIME);
    await expectHydratedClient(page);
    await expect(page.getByTestId("client-message")).toHaveText("message from wildcard export");
  });

  test("Pages Router resolves only the exact specifier through tsconfig paths", async ({
    page,
    request,
  }) => {
    const response = await request.get("/tsconfig-exact-path-pages");
    expect(response.status()).toBe(200);
    const html = (await response.text()).replaceAll("<!-- -->", "");
    expect(html).toContain(`<p data-testid="client-entry">${ENTRY}</p>`);
    expect(html).toContain(`<p data-testid="client-runtime">${RUNTIME}</p>`);

    await page.goto("/tsconfig-exact-path-pages");
    await expectHydratedClient(page);
  });
});
