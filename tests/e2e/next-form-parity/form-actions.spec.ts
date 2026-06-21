import { expect, test } from "@playwright/test";

// Ported from Next.js v16.2.6:
// test/e2e/next-form/default/shared-tests.util.ts
// test/e2e/next-form/basepath/next-form-basepath.test.ts
// https://github.com/vercel/next.js/tree/v16.2.6/test/e2e/next-form

async function waitForHydration(page: import("@playwright/test").Page) {
  await page.waitForFunction(() => {
    const form = document.querySelector<HTMLFormElement>("#same-origin-absolute");
    return form?.getAttribute("action")?.startsWith(window.location.origin);
  });
}

async function markClient(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    (window as typeof window & { __NEXT_FORM_MARKER__?: string }).__NEXT_FORM_MARKER__ = "alive";
  });
}

async function expectSoftNavigation(page: import("@playwright/test").Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as typeof window & { __NEXT_FORM_MARKER__?: string }).__NEXT_FORM_MARKER__,
      ),
    )
    .toBe("alive");
}

async function expectHardNavigation(page: import("@playwright/test").Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as typeof window & { __NEXT_FORM_MARKER__?: string }).__NEXT_FORM_MARKER__,
      ),
    )
    .toBeUndefined();
}

test.beforeEach(async ({ page, baseURL }) => {
  await page.route("http://external.test/**", async (route) => {
    const requestUrl = new URL(route.request().url());
    const query = requestUrl.searchParams.get("query") ?? "";
    const source = requestUrl.searchParams.get("source");
    await route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><p id="search-result">Query: ${query}</p>${source ? `<p id="search-source">Source: ${source}</p>` : ""}`,
    });
  });
  await page.goto(`${baseURL}/base/forms/actions`);
  await waitForHydration(page);
});

test("keeps ordinary, absolute, external, protocol-relative, and relative actions as markup", async ({
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL!).origin;

  await expect(page.locator("#ordinary-action")).toHaveAttribute("action", "/base/search");
  await expect(page.locator("#same-origin-absolute")).toHaveAttribute(
    "action",
    `${origin}/base/search`,
  );
  await expect(page.locator("#external-absolute")).toHaveAttribute(
    "action",
    "http://external.test/base/search",
  );
  await expect(page.locator("#protocol-relative")).toHaveAttribute(
    "action",
    "//external.test/base/search",
  );
  await expect(page.locator("#relative-action")).toHaveAttribute("action", "../relative/search");
  await expect(page.locator("#submitter-verbatim button")).toHaveAttribute(
    "formaction",
    "/base/search",
  );
  await expect(page.locator("#external-submitter-override button")).toHaveAttribute(
    "formaction",
    "http://external.test/base/search",
  );
});

test("adds basePath exactly once for ordinary actions", async ({ page }) => {
  await markClient(page);
  await page.locator("#ordinary-action button").click();

  await expect(page.locator("#search-result")).toHaveText("Query: ordinary");
  await expect(page).toHaveURL(/\/base\/search\?query=ordinary$/);
  await expectSoftNavigation(page);
});

test("soft-navigates same-origin absolute actions", async ({ page }) => {
  await markClient(page);
  await page.locator("#same-origin-absolute button").click();

  await expect(page.locator("#search-result")).toHaveText("Query: same-origin");
  await expectSoftNavigation(page);
});

test("resolves relative actions against the current URL", async ({ page }) => {
  await markClient(page);
  await page.locator("#relative-action button").click();

  await expect(page.locator("#relative-result")).toHaveText("Relative: relative");
  await expect(page).toHaveURL(/\/base\/relative\/search\?query=relative$/);
  await expectSoftNavigation(page);
});

test("uses submitter formAction verbatim without adding basePath", async ({ page }) => {
  await markClient(page);
  await page.locator("#submitter-verbatim button").click();

  await expect(page.locator("#search-result")).toHaveText("Query: verbatim");
  await expect(page.locator("#search-source")).toHaveText("Source: verbatim");
  await expect(page).toHaveURL(/\/base\/search\?query=verbatim&source=verbatim$/);
  await expectSoftNavigation(page);
});

for (const [name, selector, marker] of [
  ["form actions", "#dangerous-action button", "__VINEXT_FORM_DANGEROUS_ACTION__"],
  [
    "submitter formAction overrides",
    "#dangerous-submitter-override button",
    "__VINEXT_FORM_DANGEROUS_SUBMITTER__",
  ],
  [
    "javascript submitter formAction overrides",
    "#javascript-submitter-override button",
    "__VINEXT_FORM_JAVASCRIPT_SUBMITTER__",
  ],
] as const) {
  test(`blocks dangerous schemes in ${name} without executing them`, async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    const initialUrl = page.url();

    await page.locator(selector).click();

    await expect
      .poll(() =>
        errors.some((message) =>
          message.includes("has blocked a javascript: URL as a security precaution."),
        ),
      )
      .toBe(true);
    await expect(page).toHaveURL(initialUrl);
    expect(
      await page.evaluate((property) => (globalThis as Record<string, unknown>)[property], marker),
    ).toBeUndefined();
  });
}

for (const [name, selector] of [
  ["external absolute actions", "#external-absolute button"],
  ["protocol-relative actions", "#protocol-relative button"],
  ["external submitter overrides", "#external-submitter-override button"],
] as const) {
  test(`hard-navigates ${name}`, async ({ page }) => {
    await markClient(page);
    await page.locator(selector).click();

    await expect(page).toHaveURL(/http:\/\/external\.test\/base\/search\?/);
    await expect(page.locator("#search-result")).toBeVisible();
    await expectHardNavigation(page);
  });
}
