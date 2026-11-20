import { expect, test, type Page } from "@playwright/test";
import { isAppRouterRscRequestForPath, waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174";
const ROOT = `${BASE}/interception-traverse-reload`;

type MarkedWindow = Window & { __interceptionTraverseMarker?: boolean };

async function openModalThenPlain(page: Page): Promise<void> {
  await page.goto(`${ROOT}/feed`);
  await waitForAppRouterHydration(page);

  await page.click("#interception-traverse-reload-photo-link");
  await expect(page).toHaveURL(`${ROOT}/photo/1`);
  await expect(page.locator("#interception-traverse-reload-photo-modal")).toContainText(
    "Photo modal 1",
  );
  await expect(page.locator("#interception-traverse-reload-feed")).toBeVisible();

  await page.click("#interception-traverse-reload-plain-link");
  await expect(page).toHaveURL(`${ROOT}/plain`);
  await expect(page.locator("#interception-traverse-reload-plain")).toBeVisible();
  // As in Next.js, the slot keeps the modal on a soft navigation it doesn't match.
  await expect(page.locator("#interception-traverse-reload-photo-modal")).toContainText(
    "Photo modal 1",
  );
}

async function markWindow(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as MarkedWindow).__interceptionTraverseMarker = true;
  });
}

async function expectModalOverFeed(page: Page): Promise<void> {
  await expect(page).toHaveURL(`${ROOT}/photo/1`);
  await expect(page.locator("#interception-traverse-reload-photo-modal")).toContainText(
    "Photo modal 1",
  );
  await expect(page.locator("#interception-traverse-reload-feed")).toBeVisible();
  await expect(page.locator("#interception-traverse-reload-photo-page")).toHaveCount(0);
  await expect(page.locator("#interception-traverse-reload-plain")).toHaveCount(0);
  // Going back is a client navigation, not a document load.
  expect(await page.evaluate(() => (window as MarkedWindow).__interceptionTraverseMarker)).toBe(
    true,
  );
}

// Next.js 16.2.7 returns softly to an intercepted history entry it no longer
// holds a tree for: it fetches the target with the entry's Next-Url and the
// source page, and shows the modal over the source again.
test.describe("going back into an intercepted entry", () => {
  test("shows the modal over its source after a reload", async ({ page }) => {
    await openModalThenPlain(page);

    await page.reload();
    await waitForAppRouterHydration(page);
    await expect(page.locator("#interception-traverse-reload-plain")).toBeVisible();
    await markWindow(page);

    await page.goBack();

    await expectModalOverFeed(page);
  });

  test("shows the modal over its source after router.refresh", async ({ page }) => {
    await openModalThenPlain(page);
    await markWindow(page);

    const render = page.locator("#interception-traverse-reload-plain-render");
    const renderBeforeRefresh = await render.textContent();
    expect(renderBeforeRefresh).toBeTruthy();
    await page.evaluate(() => {
      const router = window.next?.router;
      if (!router || !("refresh" in router)) {
        throw new Error("window.next App Router is not installed");
      }
      router.refresh();
    });
    await expect(render).not.toHaveText(renderBeforeRefresh!);

    await page.goBack();

    await expectModalOverFeed(page);
  });

  // Each push records a new history entry's tree, and the client keeps only
  // the latest 50 (MAX_HISTORY_STATE_SNAPSHOTS in app-browser-entry.ts), while
  // going back keeps the browser's history short. The intercepted entry's own
  // tree is gone by then, but the tree committed for its route is still cached
  // and renders without a request.
  test("shows the modal over its source once its entry's tree is gone", async ({ page }) => {
    test.setTimeout(60_000);
    await openModalThenPlain(page);
    await markWindow(page);

    for (let i = 0; i < 55; i++) {
      await page.evaluate(() => {
        const router = window.next?.router;
        if (!router || !("push" in router)) {
          throw new Error("window.next App Router is not installed");
        }
        void router.push("/interception-traverse-reload/feed");
      });
      await expect(page.locator("#interception-traverse-reload-feed")).toBeVisible();
      await page.goBack();
      await expect(page.locator("#interception-traverse-reload-plain")).toBeVisible();
    }

    const photoRequests: string[] = [];
    page.on("request", (request) => {
      if (isAppRouterRscRequestForPath(request, "/interception-traverse-reload/photo/1")) {
        photoRequests.push(request.url());
      }
    });
    await page.goBack();

    await expectModalOverFeed(page);
    expect(photoRequests).toEqual([]);
  });
});

// The feed's @modal belongs to the feed layout, which /gallery doesn't render.
// Next.js still returns softly to the modal over the feed from there.
test.describe("going back into an intercepted entry from outside its slot's layout", () => {
  async function openModalThenGallery(page: Page): Promise<void> {
    await page.goto(`${BASE}/feed`);
    await waitForAppRouterHydration(page);

    await page.click("#feed-photo-42-link");
    await expect(page).toHaveURL(`${BASE}/photos/42`);
    await expect(page.locator('[data-testid="photo-modal"]')).toContainText("Viewing photo 42");
    await expect(page.locator('[data-testid="feed-page"]')).toBeVisible();

    await page.click("#gallery-link");
    await expect(page).toHaveURL(`${BASE}/gallery`);
    await expect(page.locator('[data-testid="gallery-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="photo-modal"]')).toHaveCount(0);
  }

  async function expectPhotoModalOverFeed(page: Page): Promise<void> {
    await expect(page).toHaveURL(`${BASE}/photos/42`);
    await expect(page.locator('[data-testid="photo-modal"]')).toContainText("Viewing photo 42");
    await expect(page.locator('[data-testid="feed-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="photo-page"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="gallery-page"]')).toHaveCount(0);
    expect(await page.evaluate(() => (window as MarkedWindow).__interceptionTraverseMarker)).toBe(
      true,
    );
  }

  test("shows the modal over the feed", async ({ page }) => {
    await openModalThenGallery(page);
    await markWindow(page);

    await page.goBack();

    await expectPhotoModalOverFeed(page);
  });

  test("shows the modal over the feed after a reload", async ({ page }) => {
    await openModalThenGallery(page);

    await page.reload();
    await waitForAppRouterHydration(page);
    await expect(page.locator('[data-testid="gallery-page"]')).toBeVisible();
    await markWindow(page);

    await page.goBack();

    await expectPhotoModalOverFeed(page);
  });
});
