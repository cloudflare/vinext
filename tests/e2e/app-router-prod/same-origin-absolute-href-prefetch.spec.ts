import { test, expect } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

// Link prefetching only runs in production. A same-origin absolute href whose
// pathname starts with "//" must prefetch its same-origin path, never the
// protocol-relative reference: "//about" would point at the host "about".
test("App Router <Link> prefetches a same-origin // href on the app origin", async ({ page }) => {
  await page.route(
    (url) => url.hostname === "about",
    (route) => route.fulfill({ status: 200, contentType: "text/html", body: "off-origin" }),
  );
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));

  await page.goto("/same-origin-href?path=//about");
  const origin = new URL(page.url()).origin;
  await waitForAppRouterHydration(page);

  await page.hover("#same-origin-link");
  await expect
    .poll(() =>
      requests.some((url) => {
        const parsed = new URL(url);
        return parsed.origin === origin && parsed.pathname.startsWith("/about");
      }),
    )
    .toBe(true);

  expect(requests.filter((url) => new URL(url).origin !== origin)).toEqual([]);
  expect(requests.filter((url) => /^\/\.?\/\//.test(new URL(url).pathname))).toEqual([]);
});
