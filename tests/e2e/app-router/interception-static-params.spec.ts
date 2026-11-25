import { expect, test, type Page } from "@playwright/test";
import { isAppRouterRscRequestForPath, waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174/interception-static-params";

// Next.js 16.2.7 (webpack and Turbopack) checks an interception's params
// against the intercepting route's own `dynamicParams` and
// `generateStaticParams`: the owner's layouts and the intercepting page, never
// the target page. A miss answers the RSC request 404, and the client loads the
// URL as a document.
async function openClub(page: Page, path: string) {
  await page.goto(`${BASE}/${path}`);
  await waitForAppRouterHydration(page);
  await page.evaluate(() => {
    (window as Window & { __softNavMarker?: boolean }).__softNavMarker = true;
  });
}

async function navigate(page: Page, link: string, path: string) {
  const rscResponse = page.waitForResponse(
    (response) =>
      isAppRouterRscRequestForPath(response.request(), `/interception-static-params/${path}`) &&
      response.request().headers()["next-router-prefetch"] === undefined,
  );
  await page.getByRole("link", { name: link, exact: true }).click();
  const status = (await rscResponse).status();
  await expect(page).toHaveURL(`${BASE}/${path}`);
  return status;
}

async function expectSoftNavigation(page: Page, soft: boolean) {
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as Window & { __softNavMarker?: boolean }).__softNavMarker === true,
      ),
    )
    .toBe(soft);
}

test.describe("interception dynamicParams", () => {
  test("rejects an owner param the owner layout doesn't generate", async ({ page }) => {
    await openClub(page, "owner/club/static");
    expect(await navigate(page, "Acme pics 1", "owner/club/acme/pics/1")).toBe(404);
    await expectSoftNavigation(page, false);
    await expect(page.getByTestId("club-layout")).toHaveText("owner layout: acme");
    await expect(page.getByTestId("item-page")).toHaveText("Pic page: acme 1");
    await expect(page.getByTestId("item-modal")).toHaveCount(0);
  });

  // An owner's `dynamicParams = false` enforces only where the interception's
  // last dynamic segment generates its params, or its generators give every
  // param.
  test("keeps an intercepting page without generators below that owner", async ({ page }) => {
    await openClub(page, "owner/club/acme");
    expect(await navigate(page, "Info 1", "owner/club/acme/info/1")).toBe(200);
    await expect(page.getByTestId("item-modal")).toHaveText("Info modal: acme 1");
    await expectSoftNavigation(page, true);

    await openClub(page, "owner/club/static");
    expect(await navigate(page, "Acme info 1", "owner/club/acme/info/1")).toBe(200);
    await expect(page.getByTestId("club-layout")).toHaveText("owner layout: static");
    await expect(page.getByTestId("item-modal")).toHaveText("Info modal: static 1");
    await expectSoftNavigation(page, true);
  });

  test("rejects an intercept-only param below an owner without dynamic params", async ({
    page,
  }) => {
    await openClub(page, "owner/club/acme");
    expect(await navigate(page, "Photo 1", "owner/club/acme/photo/1")).toBe(200);
    await expect(page.getByTestId("item-modal")).toHaveText("Photo modal: acme 1");
    await expectSoftNavigation(page, true);

    await openClub(page, "owner/club/acme");
    expect(await navigate(page, "Photo 2", "owner/club/acme/photo/2")).toBe(404);
    await expectSoftNavigation(page, false);
    await expect(page.getByRole("heading", { name: "404 - Page Not Found" })).toBeVisible();
  });

  test("checks the intercepting page's own generated params", async ({ page }) => {
    await openClub(page, "intercepting/club/acme");
    expect(await navigate(page, "Pics 1", "intercepting/club/acme/pics/1")).toBe(200);
    await expect(page.getByTestId("item-modal")).toHaveText("Pic modal: acme 1");
    await expectSoftNavigation(page, true);

    await openClub(page, "intercepting/club/acme");
    expect(await navigate(page, "Pics 2", "intercepting/club/acme/pics/2")).toBe(404);
    await expectSoftNavigation(page, false);
    await expect(page.getByTestId("item-page")).toHaveText("Pic page: acme 2");
    await expect(page.getByTestId("item-modal")).toHaveCount(0);

    await openClub(page, "intercepting/club/other");
    expect(await navigate(page, "Pics 1", "intercepting/club/other/pics/1")).toBe(404);
    await expectSoftNavigation(page, false);
    await expect(page.getByTestId("item-page")).toHaveText("Pic page: other 1");
  });

  test("checks an intercept-only page's own generated params", async ({ page }) => {
    await openClub(page, "intercept-only/club/acme");
    expect(await navigate(page, "Photo 1", "intercept-only/club/acme/photo/1")).toBe(200);
    await expect(page.getByTestId("item-modal")).toHaveText("Photo modal: acme 1");
    await expectSoftNavigation(page, true);

    await openClub(page, "intercept-only/club/acme");
    expect(await navigate(page, "Photo 2", "intercept-only/club/acme/photo/2")).toBe(404);
    await expectSoftNavigation(page, false);
    await expect(page.getByRole("heading", { name: "404 - Page Not Found" })).toBeVisible();

    await openClub(page, "intercept-only/club/other");
    expect(await navigate(page, "Photo 1", "intercept-only/club/other/photo/1")).toBe(404);
    await expectSoftNavigation(page, false);
    await expect(page.getByRole("heading", { name: "404 - Page Not Found" })).toBeVisible();
  });

  // The interception's own tree renders the other slots' defaults and, in
  // children, the owner's, whatever the source shows there.
  for (const base of ["defaults", "owner-default"]) {
    test(`checks the defaults in the interception's tree (${base})`, async ({ page }) => {
      await openClub(page, `${base}/club/acme`);
      expect(await navigate(page, "Pics 1", `${base}/club/acme/pics/1`)).toBe(200);
      await expect(page.getByTestId("item-modal")).toHaveText("Pic modal: acme 1");
      await expectSoftNavigation(page, true);

      await openClub(page, `${base}/club/acme`);
      expect(await navigate(page, "Pics 2", `${base}/club/acme/pics/2`)).toBe(404);
      await expectSoftNavigation(page, false);
      await expect(page.getByTestId("item-page")).toHaveText("Pic page: acme 2");

      await openClub(page, `${base}/club/other`);
      expect(await navigate(page, "Pics 1", `${base}/club/other/pics/1`)).toBe(404);
      await expectSoftNavigation(page, false);
      await expect(page.getByTestId("item-page")).toHaveText("Pic page: other 1");
    });
  }

  test("chains a default's generator into the intercepting page's", async ({ page }) => {
    for (const [slug, generated, missing] of [
      ["acme", "1", "2"],
      ["other", "2", "1"],
    ]) {
      await openClub(page, `chained/club/${slug}`);
      expect(
        await navigate(page, `Pics ${generated}`, `chained/club/${slug}/pics/${generated}`),
      ).toBe(200);
      await expect(page.getByTestId("item-modal")).toHaveText(`Pic modal: ${slug} ${generated}`);
      await expectSoftNavigation(page, true);

      await openClub(page, `chained/club/${slug}`);
      expect(await navigate(page, `Pics ${missing}`, `chained/club/${slug}/pics/${missing}`)).toBe(
        404,
      );
      await expectSoftNavigation(page, false);
      await expect(page.getByTestId("item-page")).toHaveText(`Pic page: ${slug} ${missing}`);
    }
  });

  test("runs the owner's default before the slot's layout", async ({ page }) => {
    await openClub(page, "ordered/club/acme");
    expect(await navigate(page, "Pics 1", "ordered/club/acme/pics/1")).toBe(200);
    await expect(page.getByTestId("item-modal")).toHaveText("Pic modal: acme 1");
    await expectSoftNavigation(page, true);

    await openClub(page, "ordered/club/acme");
    expect(await navigate(page, "Pics 2", "ordered/club/acme/pics/2")).toBe(404);
    await expectSoftNavigation(page, false);
    await expect(page.getByTestId("item-page")).toHaveText("Pic page: acme 2");
  });

  test("checks an intercepting page below the last dynamic segment", async ({ page }) => {
    await openClub(page, "nested/club/acme");
    expect(await navigate(page, "Details 1", "nested/club/acme/pics/1/details")).toBe(200);
    await expect(page.getByTestId("item-modal")).toHaveText("Details modal: acme 1");
    await expectSoftNavigation(page, true);

    await openClub(page, "nested/club/acme");
    expect(await navigate(page, "Details 2", "nested/club/acme/pics/2/details")).toBe(404);
    await expectSoftNavigation(page, false);
    await expect(page.getByTestId("item-page")).toHaveText("Details page: acme 2");

    await openClub(page, "nested/club/other");
    expect(await navigate(page, "Details 1", "nested/club/other/pics/1/details")).toBe(404);
    await expectSoftNavigation(page, false);
    await expect(page.getByTestId("item-page")).toHaveText("Details page: other 1");
  });

  test("starts the interception's first generator without params", async ({ page }) => {
    await openClub(page, "seeded/club/acme");
    expect(await navigate(page, "Pics 1", "seeded/club/acme/pics/1")).toBe(200);
    await expect(page.getByTestId("item-modal")).toHaveText("Pic modal: acme 1");
    await expectSoftNavigation(page, true);

    await openClub(page, "seeded/club/acme");
    expect(await navigate(page, "Pics 2", "seeded/club/acme/pics/2")).toBe(404);
    await expectSoftNavigation(page, false);
    await expect(page.getByTestId("item-page")).toHaveText("Pic page: acme 2");
  });

  // Next.js 16.2.7 answers this miss 500 after an internal invariant error,
  // with the same document load.
  test("checks a dynamic segment behind an interception marker", async ({ page }) => {
    await openClub(page, "shots/1");
    expect(await navigate(page, "Shot 2", "shots/2")).toBe(200);
    await expect(page.getByTestId("shot-modal")).toHaveText("Shot modal: 2");
    await expect(page.getByTestId("shot-page")).toHaveText("Shot page: 1");
    await expectSoftNavigation(page, true);

    await openClub(page, "shots/1");
    expect(await navigate(page, "Shot 3", "shots/3")).toBe(404);
    await expectSoftNavigation(page, false);
    await expect(page.getByTestId("shot-page")).toHaveText("Shot page: 3");
    await expect(page.getByTestId("shot-modal")).toHaveCount(0);
  });

  // Next.js enforces `dynamicParams = false` only where it builds the
  // interception's paths: not without a generator at its last dynamic
  // segment, nor on the edge runtime.
  for (const base of ["no-generator", "edge"]) {
    test(`intercepts any params where Next.js builds no paths (${base})`, async ({ page }) => {
      for (const id of ["1", "2"]) {
        await openClub(page, `${base}/club/acme`);
        expect(await navigate(page, `Pics ${id}`, `${base}/club/acme/pics/${id}`)).toBe(200);
        await expect(page.getByTestId("item-modal")).toHaveText(`Pic modal: acme ${id}`);
        await expect(page.getByTestId("club-page")).toHaveText("Club page: acme");
        await expectSoftNavigation(page, true);
      }
    });
  }

  test("ignores the target page's dynamicParams", async ({ page }) => {
    await openClub(page, "target/club/acme");
    expect(await navigate(page, "Pics 2", "target/club/acme/pics/2")).toBe(200);
    await expect(page.getByTestId("item-modal")).toHaveText("Pic modal: acme 2");
    await expect(page.getByTestId("club-page")).toHaveText("Club page: acme");
    await expectSoftNavigation(page, true);

    await openClub(page, "target/club/other");
    expect(await navigate(page, "Pics 1", "target/club/other/pics/1")).toBe(200);
    await expect(page.getByTestId("item-modal")).toHaveText("Pic modal: other 1");
    await expectSoftNavigation(page, true);
  });
});
