import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 60_000 });

// Ported from Next.js: test/e2e/app-dir/segment-cache/search-params/segment-cache-search-params-shared-loading-state.test.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/segment-cache/search-params/segment-cache-search-params-shared-loading-state.test.ts
test("reuses a static full prefetch across search params for shared loading state", async ({
  page,
}) => {
  const targetPath = "/search-params-shared-loading-state/target-page";
  let noSearchPrefetchComplete: (() => void) | undefined;
  let exactSearchVariantStarted: (() => void) | undefined;
  let exactSearchVariantRequests = 0;
  let blockExactSearchVariant = false;
  const releaseBlockedExactRequests = new Set<() => void>();

  const noSearchPrefetched = new Promise<void>((resolve) => {
    noSearchPrefetchComplete = resolve;
  });
  const exactSearchVariantPrefetchStarted = new Promise<void>((resolve) => {
    exactSearchVariantStarted = resolve;
  });

  await page.route(`**${targetPath}*`, async (route) => {
    const request = route.request();
    const headers = request.headers();
    const url = new URL(request.url());
    const isRscRequest = url.pathname === targetPath && headers.rsc === "1";

    if (
      isRscRequest &&
      url.searchParams.get("param") === null &&
      headers["x-vinext-rsc-render-mode"] !== "prefetch-loading-shell"
    ) {
      const response = await route.fetch();
      await route.fulfill({ response });
      noSearchPrefetchComplete?.();
      return;
    }

    if (isRscRequest && url.searchParams.get("param") === "test") {
      exactSearchVariantRequests += 1;
      exactSearchVariantStarted?.();
      if (blockExactSearchVariant) {
        await new Promise<void>((resolve) => {
          releaseBlockedExactRequests.add(resolve);
        });
        await route.abort();
        return;
      }
    }

    await route.continue();
  });

  try {
    await page.goto("/search-params-shared-loading-state");

    await page
      .locator('input[data-link-accordion="/search-params-shared-loading-state/target-page"]')
      .click();
    await noSearchPrefetched;

    blockExactSearchVariant = true;
    await page
      .locator(
        'input[data-link-accordion="/search-params-shared-loading-state/target-page?param=test"]',
      )
      .click();
    await exactSearchVariantPrefetchStarted;
    expect(exactSearchVariantRequests).toBe(1);

    await page
      .locator('a[href="/search-params-shared-loading-state/target-page?param=test"]')
      .click();

    await expect(page.locator("#static-content")).toHaveText("Static content");
    await expect(page.locator("#search-params-content")).toHaveText("Search param value: test");
    expect(exactSearchVariantRequests).toBe(1);
  } finally {
    blockExactSearchVariant = false;
    for (const release of releaseBlockedExactRequests) {
      release();
    }
  }
});

test("waits for exact searched data when the server page renders searchParams", async ({
  page,
}) => {
  const targetPath = "/search-params-shared-loading-state/target-page-server-search";
  let noSearchPrefetchComplete: (() => void) | undefined;
  let exactSearchVariantStarted: (() => void) | undefined;
  let releaseExactSearchVariant: (() => void) | undefined;
  let exactSearchVariantRequests = 0;

  const noSearchPrefetched = new Promise<void>((resolve) => {
    noSearchPrefetchComplete = resolve;
  });
  const exactSearchVariantPrefetchStarted = new Promise<void>((resolve) => {
    exactSearchVariantStarted = resolve;
  });
  const exactSearchVariantReleased = new Promise<void>((resolve) => {
    releaseExactSearchVariant = resolve;
  });

  await page.route(`**${targetPath}*`, async (route) => {
    const request = route.request();
    const headers = request.headers();
    const url = new URL(request.url());
    const isRscRequest = url.pathname === targetPath && headers.rsc === "1";

    if (isRscRequest && url.searchParams.get("param") === null) {
      const response = await route.fetch();
      await route.fulfill({ response });
      noSearchPrefetchComplete?.();
      return;
    }

    if (isRscRequest && url.searchParams.get("param") === "test") {
      exactSearchVariantRequests += 1;
      exactSearchVariantStarted?.();
      await exactSearchVariantReleased;
    }

    await route.continue();
  });

  await page.goto("/search-params-shared-loading-state");

  await page
    .locator(
      'input[data-link-accordion="/search-params-shared-loading-state/target-page-server-search"]',
    )
    .click();
  await noSearchPrefetched;

  await page
    .locator(
      'input[data-link-accordion="/search-params-shared-loading-state/target-page-server-search?param=test"]',
    )
    .click();
  await exactSearchVariantPrefetchStarted;
  expect(exactSearchVariantRequests).toBe(1);

  await page
    .locator('a[href="/search-params-shared-loading-state/target-page-server-search?param=test"]')
    .click();

  await expect(page.locator("#server-search-param")).toHaveCount(0);
  releaseExactSearchVariant?.();
  await expect(page.locator("#server-search-param")).toHaveText("Server search param value: test");
  expect(exactSearchVariantRequests).toBeGreaterThanOrEqual(1);
});

test("does not reuse hydration-seeded no-search data for searched server searchParams", async ({
  page,
}) => {
  const targetPath = "/search-params-shared-loading-state/target-page-server-search";
  let releaseExactSearchVariant: (() => void) | undefined;
  let exactSearchVariantRequests = 0;

  const exactSearchVariantReleased = new Promise<void>((resolve) => {
    releaseExactSearchVariant = resolve;
  });

  await page.route(`**${targetPath}*`, async (route) => {
    const request = route.request();
    const headers = request.headers();
    const url = new URL(request.url());
    const isRscRequest = url.pathname === targetPath && headers.rsc === "1";

    if (isRscRequest && url.searchParams.get("param") === "test") {
      exactSearchVariantRequests += 1;
      await exactSearchVariantReleased;
    }

    await route.continue();
  });

  try {
    await page.goto(targetPath);
    await expect(page.locator("#server-search-param")).toHaveText(
      "Server search param value: none",
    );

    const clickPromise = page.locator("#server-search-param-link").click();
    await expect
      .poll(() => exactSearchVariantRequests, { timeout: 5_000 })
      .toBeGreaterThanOrEqual(1);
    await expect(page.locator("#server-search-param")).toHaveText(
      "Server search param value: none",
    );

    releaseExactSearchVariant?.();
    await clickPromise;
    await expect(page.locator("#server-search-param")).toHaveText(
      "Server search param value: test",
    );
  } finally {
    releaseExactSearchVariant?.();
  }
});
