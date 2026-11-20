import { test, expect, type Page } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174";
const ROOT = "/nextjs-compat/intercept-metadata-files";

type MarkedWindow = Window & { __interceptMetadataFilesMarker?: boolean };

// A head without twitter images of its own takes the Open Graph ones, as in
// Next.js, so the route group's twitter-image file shows by its name only.
const GROUP_TWITTER_IMAGE =
  /\/nextjs-compat\/intercept-metadata-files\/twitter-image-[a-z0-9]+\.png\?[^/]+$/;

function readContents(page: Page, selector: string): Promise<string[]> {
  return page
    .locator(selector)
    .evaluateAll((elements) => elements.map((element) => element.getAttribute("content") ?? ""));
}

async function openFirst(page: Page) {
  await page.goto(`${BASE}${ROOT}/first`);
  await waitForAppRouterHydration(page);
  await expect(page.locator("#intercept-metadata-files-first")).toBeVisible();
  // `/first` renders only in @modal, outside the route group.
  for (const content of await readContents(page, 'meta[name="twitter:image"]')) {
    expect(content).not.toMatch(GROUP_TWITTER_IMAGE);
  }
  await page.evaluate(() => {
    (window as MarkedWindow).__interceptMetadataFilesMarker = true;
  });
}

// The head's image URLs are served: the marker's folder stays in them. Without
// a metadataBase they are absolute on the default localhost:3000 origin, as in
// Next.js, so only their path is fetched from this server.
async function expectServedImages(page: Page, selector: string) {
  const contents = await readContents(page, selector);
  expect(contents.length).toBeGreaterThan(0);
  for (const content of contents) {
    const { pathname, search } = new URL(content, page.url());
    const response = await page.request.get(new URL(`${pathname}${search}`, page.url()).href);
    expect(response.status(), content).toBe(200);
    expect(response.headers()["content-type"], content).toMatch(/^image\//);
  }
}

async function expectSoftNavigation(page: Page) {
  expect(await page.evaluate(() => (window as MarkedWindow).__interceptMetadataFilesMarker)).toBe(
    true,
  );
}

// Next.js 16.2.7 (webpack and Turbopack) heads an intercepted navigation by
// the intercepting route's tree: the slot's folders down to the intercepting
// page, its route groups, the marker's folder and the page's own, the deepest
// file of each kind winning. A dynamic file there is filled with the
// intercepting route's params.
test.describe("metadata files of an intercepting page", () => {
  test("a static file in the intercepting page's folder and a route group above it head the route", async ({
    page,
  }) => {
    await openFirst(page);

    await page.getByRole("link", { name: "Photo 1" }).click();
    await expect(page).toHaveURL(new RegExp(`${ROOT}/photo/1$`));
    await expect(page.locator("#intercept-metadata-files-photo-modal")).toHaveText(
      "Photo modal: 1",
    );
    await expectSoftNavigation(page);

    const ogImage = page.locator('meta[property="og:image"]');
    await expect(ogImage).toHaveCount(1);
    await expect(ogImage).toHaveAttribute(
      "content",
      /\/nextjs-compat\/intercept-metadata-files\/\(\.\)photo\/-\/opengraph-image-[a-z0-9]+\.png\?[^/]+$/,
    );
    const twitterImage = page.locator('meta[name="twitter:image"]');
    await expect(twitterImage).toHaveCount(1);
    await expect(twitterImage).toHaveAttribute("content", GROUP_TWITTER_IMAGE);
    await expectServedImages(page, 'meta[property="og:image"], meta[name="twitter:image"]');
  });

  test("a dynamic file in the intercepting page's folder is filled with the intercepting route's params", async ({
    page,
  }) => {
    await openFirst(page);

    await page.getByRole("link", { name: "Shot 2" }).click();
    await expect(page).toHaveURL(new RegExp(`${ROOT}/shot/2$`));
    await expect(page.locator("#intercept-metadata-files-shot-modal")).toHaveText("Shot modal: 2");
    await expectSoftNavigation(page);

    const ogImage = page.locator('meta[property="og:image"]');
    await expect(ogImage).toHaveCount(1);
    await expect(ogImage).toHaveAttribute(
      "content",
      /\/nextjs-compat\/intercept-metadata-files\/\(\.\)shot\/2\/opengraph-image-[a-z0-9]+(\?[^/]+)?$/,
    );
    await expectServedImages(page, 'meta[property="og:image"]');
    for (const content of await readContents(page, 'meta[name="twitter:image"]')) {
      expect(content).not.toMatch(GROUP_TWITTER_IMAGE);
    }
  });

  test("the intercepted pages loaded directly read none of the intercepting pages' files", async ({
    page,
  }) => {
    for (const { pathname, selector } of [
      { pathname: "/photo/1", selector: "#intercept-metadata-files-photo-page" },
      { pathname: "/shot/2", selector: "#intercept-metadata-files-shot-page" },
    ]) {
      await page.goto(`${BASE}${ROOT}${pathname}`);
      await expect(page.locator(selector)).toBeVisible();
      for (const content of await readContents(
        page,
        'meta[property="og:image"], meta[name="twitter:image"]',
      )) {
        expect(content).not.toMatch(/\/\(\.\)(photo|shot)\//);
        expect(content).not.toMatch(GROUP_TWITTER_IMAGE);
      }
    }
  });
});
