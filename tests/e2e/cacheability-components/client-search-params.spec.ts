import { expect, test } from "@playwright/test";

const attackerTarget = "https://attacker.example/continue";

// Next.js prerenders a cacheComponents page whose client component reads
// useSearchParams() inside Suspense as fully static: every query is served the
// stored Suspense fallback, and the browser renders the real value after
// hydration. The shared entry must never carry one visitor's query.
test("keeps the query out of a cacheComponents page's Suspense useSearchParams() HTML", async ({
  page,
  request,
}) => {
  for (const search of [`?next=${encodeURIComponent(attackerTarget)}`, "", "?next=/dashboard"]) {
    const response = await request.get(`/client-search-params${search}`);
    expect(response.status(), search).toBe(200);
    const html = await response.text();
    expect(html, search).toContain('<p id="search-params-fallback">loading</p>');
    expect(html, search).not.toContain("attacker.example");
    expect(html, search).not.toContain('id="continue"');
  }

  await page.goto("/client-search-params?next=/dashboard");
  await expect(page.locator("#continue")).toHaveAttribute("href", "/dashboard");
  await page.goto("/client-search-params");
  await expect(page.locator("#continue")).toHaveAttribute("href", "/default");
});
