import { expect, test, type Page } from "@playwright/test";

import { waitForHydration } from "../helpers";

// An empty leading param interpolates `/[id]/details` to `//details`, which
// the browser would load as a protocol-relative URL on another host. Next.js
// Router.change() rejects it because the `as` no longer matches the route.
const INCOMPATIBLE_AS =
  "The provided `as` value (//details) is incompatible with the `href` value (/[id]/details).";
// An explicit `as` (which Link passes) first has its repeated slashes
// collapsed, as Next.js resolveHref does, so the mismatch reports `/details`.
const INCOMPATIBLE_NORMALIZED_AS =
  "The provided `as` value (/details) is incompatible with the `href` value (/[id]/details).";

function recordOffOriginRequests(page: Page, origin: string): string[] {
  const offOrigin: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== origin) offOrigin.push(request.url());
  });
  return offOrigin;
}

async function push(page: Page, url: string | { pathname: string; query: object }, as?: string) {
  return page.evaluate(
    ([target, mask]) => {
      const router = window.next?.router as
        | {
            push(url: string | { pathname: string; query: object }, as?: string): Promise<boolean>;
          }
        | undefined;
      if (!router) throw new Error("window.next.router is not installed");
      return router.push(target, mask).then(
        () => "resolved",
        (error: unknown) => String(error),
      );
    },
    [url, as] as const,
  );
}

test.describe("Pages Router dynamic href interpolation", () => {
  test("rejects an empty leading param instead of leaving the origin", async ({
    page,
    baseURL,
  }) => {
    const origin = new URL(baseURL!).origin;
    const offOrigin = recordOffOriginRequests(page, origin);
    await page.goto(`${baseURL}/pages-dir/start`);
    await waitForHydration(page);

    expect(await push(page, { pathname: "/[id]/details", query: { id: "" } })).toContain(
      INCOMPATIBLE_AS,
    );
    expect(await push(page, "/[id]/details?id=")).toContain(INCOMPATIBLE_AS);
    expect(await push(page, "/[id]/details", "//details")).toContain(INCOMPATIBLE_NORMALIZED_AS);
    expect(page.url()).toBe(`${baseURL}/pages-dir/start`);
    expect(offOrigin).toEqual([]);
  });

  for (const linkId of ["empty-param-link", "empty-param-replace-link"]) {
    test(`keeps a Link click on #${linkId} on the origin`, async ({ page, baseURL }) => {
      const origin = new URL(baseURL!).origin;
      const offOrigin = recordOffOriginRequests(page, origin);
      const pageErrors: string[] = [];
      const consoleErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });
      await page.goto(`${baseURL}/href-interpolation`);
      await waitForHydration(page);

      // The rendered href is the interpolated value, as in Next.js.
      await expect(page.locator(`#${linkId}`)).toHaveAttribute("href", "//details");
      await page.click(`#${linkId}`);

      await expect.poll(() => pageErrors.join("\n")).toContain(INCOMPATIBLE_NORMALIZED_AS);
      expect(consoleErrors.join("\n")).toContain(
        "Invalid href '//details' passed to next/router in page: '/href-interpolation'.",
      );
      expect(page.url()).toBe(`${baseURL}/href-interpolation`);
      expect(offOrigin).toEqual([]);
    });
  }

  test("still navigates a Link with a non-empty param", async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/href-interpolation`);
    await waitForHydration(page);

    await page.click("#valid-param-link");
    await expect(page.locator("#route-owner")).toHaveText("pages");
    expect(page.url()).toBe(`${baseURL}/abc/details`);
  });
});
