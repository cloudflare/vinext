import { expect, test } from "@playwright/test";
import { waitForHydration } from "../helpers";

const BASE = "http://localhost:4190";

// Next.js 16.2.7 prefixes the basePath before parsing the destination
// template, so `..` resolves against it and `/` becomes the bare basePath.
test("resolves the destination template after the basePath prefixes it", async ({ request }) => {
  for (const [pathname, location] of [
    ["/docs/basepath-dot-redirect/", "/outside"],
    ["/docs/basepath-root-redirect/", "/docs"],
  ]) {
    const res = await request.get(`${BASE}${pathname}`, { maxRedirects: 0 });
    expect(res.status()).toBe(307);
    expect(res.headers()["location"]).toBe(location);
  }
});

// A client navigation follows a redirect that leaves the basePath to the same
// URL as the server's Location, rather than re-adding the basePath.
test("client navigation follows a redirect out of the basePath", async ({ page }) => {
  await page.goto(`${BASE}/docs/`);
  await waitForHydration(page);
  const documentRequest = page.waitForRequest(
    (request) => request.isNavigationRequest() && new URL(request.url()).pathname !== "/docs/",
  );
  await page.evaluate(() => {
    void (
      window as unknown as { next: { router: { push(url: string): Promise<boolean> } } }
    ).next.router.push("/basepath-dot-redirect/");
  });
  expect((await documentRequest).url()).toBe(`${BASE}/outside`);
});
