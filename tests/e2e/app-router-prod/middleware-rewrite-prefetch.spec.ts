import { test, expect } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const REWRITTEN_HREF = "/middleware-rewrite-prefetch-target";

// Link prefetching only runs in production. Next.js's <Link> has no route
// manifest: a default (auto) prefetch asks the server for the href, and the
// server applies the middleware rewrite (`x-nextjs-rewritten-path`). An href
// that matches no App route by itself and reaches a page only through a
// middleware or proxy rewrite must still be prefetched before any click.
// Checked against next@16.2.7 `next build` (Turbopack and webpack) +
// `next start`.
test("App Router <Link> prefetches an href only a middleware rewrite resolves", async ({
  page,
}) => {
  const prefetches: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "document") return;
    const { pathname } = new URL(request.url());
    if (pathname.replace(/\.rsc$/, "") !== REWRITTEN_HREF) return;
    if (request.headers()["next-router-prefetch"] !== "1") return;
    prefetches.push(request.url());
  });

  await page.goto("/middleware-rewrite-prefetch");
  await waitForAppRouterHydration(page);

  await expect.poll(() => prefetches.length).toBeGreaterThan(0);

  await page.click("#rewritten-link");
  await expect(page.locator("#app-page")).toHaveText("About");
  expect(new URL(page.url()).pathname).toBe(REWRITTEN_HREF);
});
