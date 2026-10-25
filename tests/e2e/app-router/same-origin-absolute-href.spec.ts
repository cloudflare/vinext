import { test, expect, type Page } from "@playwright/test";
import { waitForAppRouterHydration, waitForHydration } from "../helpers";

// A same-origin absolute URL whose pathname starts with "//" passes the usual
// app-side `new URL(href).origin === location.origin` check. Its local path
// must never become the protocol-relative "//attacker.example/..." reference.
// Next.js navigates with the full URL, and repeated slashes are collapsed
// (by the client router or the server's 308), so the navigation settles on
// the same-origin path.
async function openOnAppOrigin(page: Page, startPath: string) {
  await page.route(
    (url) => url.host === "attacker.example",
    (route) => route.fulfill({ status: 200, contentType: "text/html", body: "off-origin" }),
  );
  await page.goto(startPath);
  const origin = new URL(page.url()).origin;
  const offOriginRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== origin) offOriginRequests.push(request.url());
  });
  return { origin, offOriginRequests };
}

async function pushFromWindowRouter(page: Page, href: string): Promise<void> {
  await page.evaluate((target) => {
    const router = window.next?.router;
    if (!router) throw new Error("window.next.router is not installed");
    void router.push(target);
  }, href);
}

test.describe("same-origin absolute hrefs with a // pathname", () => {
  test("App Router <Link> stays on the app origin", async ({ page }) => {
    const { origin, offOriginRequests } = await openOnAppOrigin(
      page,
      "/same-origin-href?path=//attacker.example/about",
    );
    await waitForAppRouterHydration(page);

    await page.click("#same-origin-link");

    await expect(page).toHaveURL(`${origin}/attacker.example/about`);
    expect(offOriginRequests).toEqual([]);
  });

  test("Pages Router <Link> stays on the app origin", async ({ page }) => {
    const { origin, offOriginRequests } = await openOnAppOrigin(
      page,
      "/pages-same-origin-href?path=//attacker.example/old-school",
    );
    await waitForHydration(page);

    await page.click("#same-origin-link");

    await expect(page).toHaveURL(`${origin}/attacker.example/old-school`);
    expect(offOriginRequests).toEqual([]);
  });

  test("App Router router.push stays on the app origin", async ({ page }) => {
    const { origin, offOriginRequests } = await openOnAppOrigin(page, "/about");
    await waitForAppRouterHydration(page);

    await pushFromWindowRouter(page, `${origin}//attacker.example/about`);

    await expect(page).toHaveURL(`${origin}/attacker.example/about`);
    expect(offOriginRequests).toEqual([]);
  });

  test("Pages Router router.push stays on the app origin", async ({ page }) => {
    const { origin, offOriginRequests } = await openOnAppOrigin(page, "/old-school");
    await waitForHydration(page);

    await pushFromWindowRouter(page, `${origin}//attacker.example/old-school`);

    await expect(page).toHaveURL(`${origin}/attacker.example/old-school`);
    expect(offOriginRequests).toEqual([]);
  });
});
