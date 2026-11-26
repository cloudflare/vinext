import { test, expect, type Page } from "@playwright/test";
import { waitForHydration } from "../helpers";

// next/legacy/image renders this 1x1 GIF until its IntersectionObserver sees
// the image (client/legacy/image.tsx `emptyDataURL`).
const EMPTY_DATA_URL =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

function src(page: Page, id: string) {
  return page.locator(`#${id}`).getAttribute("src");
}

// TEMP CI diagnostics
test.beforeEach(async ({ page }) => {
  page.on("pageerror", (e) => console.log("DIAG pageerror", e.message));
  page.on("console", (m) => console.log("DIAG console", m.type(), m.text().slice(0, 400)));
  page.on("requestfailed", (r) => console.log("DIAG requestfailed", r.url(), r.failure()?.errorText));
  page.on("response", (r) => {
    if (r.status() >= 300) console.log("DIAG response", r.status(), r.url().slice(0, 200));
  });
});
test.afterEach(async ({ page }, info) => {
  if (info.status === info.expectedStatus) return;
  const state = await page
    .evaluate(() => {
      const near = document.querySelector<HTMLImageElement>("#near-image");
      const blurry = document.querySelector<HTMLImageElement>("#blurry-image");
      const root = document.querySelector("#lazy-root");
      return {
        root: Boolean((window as unknown as { __VINEXT_ROOT__?: unknown }).__VINEXT_ROOT__),
        io: typeof IntersectionObserver,
        visibility: document.visibilityState,
        near: near && { src: near.src.slice(0, 60), rect: near.getBoundingClientRect().toJSON() },
        rootRect: root?.getBoundingClientRect().toJSON(),
        blurry: blurry && {
          src: blurry.currentSrc,
          complete: blurry.complete,
          naturalWidth: blurry.naturalWidth,
          style: blurry.getAttribute("style"),
        },
        scripts: [...document.scripts].map((s) => s.src || s.textContent?.slice(0, 80)),
      };
    })
    .catch((e) => String(e));
  console.log("DIAG state", JSON.stringify(state));
});

// Ported from Next.js: test/e2e/next-image-legacy/default/default.test.ts
// ("should initially load only two of four images using lazyroot",
// "should re-lazyload images after src changes",
// "should remove blurry placeholder after image loads")
// https://github.com/vercel/next.js/blob/canary/test/e2e/next-image-legacy/default/default.test.ts
test("legacy lazy images server-render a placeholder and a noscript fallback", async ({ page }) => {
  const html = await (await page.request.get("/legacy-image-lazy")).text();
  expect(html).toContain(`id="far-image" alt="far" src="${EMPTY_DATA_URL}"`);
  // One fallback per lazy or blur image.
  expect(html.match(/<noscript>/g)).toHaveLength(3);
});

test("legacy images load once they intersect their lazyRoot", async ({ page }) => {
  await page.goto("/legacy-image-lazy");
  await waitForHydration(page);
  await expect(page.locator("#near-image")).toHaveAttribute(
    "src",
    "/_next/image?url=%2Fheart.png&w=32&q=75",
  );
  expect(await src(page, "far-image")).toBe(EMPTY_DATA_URL);

  await page.locator("#far-image").scrollIntoViewIfNeeded();
  await expect(page.locator("#far-image")).toHaveAttribute(
    "src",
    "/_next/image?url=%2Fheart.png&w=32&q=75",
  );
});

test("legacy images lazy-load again after their src changes", async ({ page }) => {
  await page.goto("/legacy-image-lazy");
  await waitForHydration(page);
  await page.locator("#far-image").scrollIntoViewIfNeeded();
  await expect(page.locator("#far-image")).toHaveAttribute(
    "src",
    "/_next/image?url=%2Fheart.png&w=32&q=75",
  );

  await page.locator("#lazy-root").evaluate((root) => root.scrollTo(0, 0));
  await page.locator("#change-src").click();
  await expect(page.locator("#far-image")).toHaveAttribute("src", EMPTY_DATA_URL);

  await page.locator("#far-image").scrollIntoViewIfNeeded();
  await expect(page.locator("#far-image")).toHaveAttribute("src", "/logo.svg");
});

test("legacy blur placeholders clear once the image loads", async ({ page }) => {
  await page.goto("/legacy-image-lazy");
  await waitForHydration(page);
  await expect
    .poll(() =>
      page
        .locator("#blurry-image")
        .evaluate((img) => getComputedStyle(img).getPropertyValue("background-image")),
    )
    .toBe("none");
});
