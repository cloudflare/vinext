import { test, expect } from "@playwright/test";

test.describe("Document", () => {
  test("page includes theme attribute on the body", async ({ page }) => {
    await page.goto("/");

    await expect(page.getAttribute("body", "data-theme-prop")).resolves.toBe("light");
  });

  test("page includes app prop attribute", async ({ page }) => {
    await page.goto("/?appProp=value");

    await expect(page.getAttribute("#app-wrapper", "data-app-prop")).resolves.toBe("value");
  });

  test("error pages (404) also use the custom _document and get getInitialProps", async ({
    page,
  }) => {
    // The fixture _document adds data-theme-prop via getInitialProps.
    // Visiting a nonexistent route triggers renderErrorPage, which should
    // also call getInitialProps and wrap with the custom document.
    await page.goto("/this-page-does-not-exist");

    await expect(page.getAttribute("body", "data-theme-prop")).resolves.toBe("light");
  });

  test("basic document structure is present (id=__next, html/head/body)", async ({ page }) => {
    // Regression test: verifies that the document shell renders correctly
    // regardless of whether a class-based or function-based document is used.
    await page.goto("/");

    await expect(page.locator("#__next")).toBeVisible();
    // The custom _document renders <html lang="en">
    const htmlLang = await page.evaluate(() => document.documentElement.lang);
    expect(htmlLang).toBe("en");
  });

  test("getInitialProps receives the correct pathname via DocumentContext", async ({ page }) => {
    // Navigate to /about and verify that ctx.pathname was correctly set to "/about"
    // in DocumentContext — the fixture stores ctx.pathname as data-pathname on <body>.
    await page.goto("/about");

    await expect(page.getAttribute("body", "data-theme-prop")).resolves.toBe("light");
    await expect(page.getAttribute("body", "data-pathname")).resolves.toBe("/about");
    // The about page content should be present inside the document shell
    await expect(page.locator("#__next")).toBeVisible();
  });
});
