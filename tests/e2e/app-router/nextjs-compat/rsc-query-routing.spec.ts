// Ported from Next.js: test/e2e/app-dir/rsc-query-routing/rsc-query-routing.test.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/rsc-query-routing/rsc-query-routing.test.ts
import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../../helpers";

const BASE = "http://localhost:4174";

test("preserves the hashed RSC query across a config redirect", async ({ page }) => {
  await page.goto(`${BASE}/nextjs-compat/rsc-query-redirect`);
  await waitForAppRouterHydration(page);

  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("?_rsc=")) requests.push(request.url());
  });

  await page.getByRole("link", { name: "Redirect Link" }).click();
  await expect(page.getByRole("heading", { name: "Redirect Dest" })).toBeVisible();

  expect(requests[0]).toContain("/nextjs-compat/rsc-query-redirect/source?_rsc=");
  expect(requests[1]).toContain("/nextjs-compat/rsc-query-redirect/dest?_rsc=");
});

test("includes the hashed RSC query on the rewrite source request", async ({ page }) => {
  await page.goto(`${BASE}/nextjs-compat/rsc-query-rewrite`);
  await waitForAppRouterHydration(page);

  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("?_rsc=")) requests.push(request.url());
  });

  await page.getByRole("link", { name: "Rewrite Link" }).click();
  await expect(page.getByRole("heading", { name: "Rewrite Dest" })).toBeVisible();

  expect(requests[0]).toContain("/nextjs-compat/rsc-query-rewrite/source?_rsc=");
});
