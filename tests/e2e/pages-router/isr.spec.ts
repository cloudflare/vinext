import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4173";

test.describe("Pages Router getStaticProps in development", () => {
  // Next.js does not create a response-cache key for Pages routes in development.
  // getStaticProps runs for every request, including when `revalidate` is configured.
  test("rerenders every request with Next.js development cache headers", async ({ request }) => {
    const first = await request.get(`${BASE}/isr-test`);
    expect(first.status()).toBe(200);
    const firstHtml = await first.text();
    expect(firstHtml).toContain("ISR Page");
    expect(firstHtml).toContain("Hello from ISR");

    const second = await request.get(`${BASE}/isr-test`);
    expect(second.status()).toBe(200);
    const secondHtml = await second.text();

    const firstGeneration = Number(firstHtml.match(/data-testid="generation">(\d+)</)?.[1]);
    const secondGeneration = Number(secondHtml.match(/data-testid="generation">(\d+)</)?.[1]);
    expect(firstGeneration).toBeGreaterThan(0);
    expect(secondGeneration).toBeGreaterThan(firstGeneration);

    for (const response of [first, second]) {
      expect(response.headers()["x-nextjs-cache"]).toBe("HIT");
      expect(response.headers()["x-vinext-cache"]).toBeUndefined();
      expect(response.headers()["cache-control"]).toBe("no-cache, must-revalidate");
    }
  });

  test("non-ISR page does not have ISR cache headers", async ({ request }) => {
    const res = await request.get(`${BASE}/about`);

    const cacheHeader = res.headers()["x-vinext-cache"];
    expect(cacheHeader).toBeUndefined();
  });

  test("ISR page renders correctly in browser with timestamp", async ({ page }) => {
    await page.goto(`${BASE}/isr-test`);

    await expect(page.locator("h1")).toHaveText("ISR Page");
    await expect(page.getByTestId("message")).toHaveText("Hello from ISR");

    // Timestamp should be a valid number
    const tsText = await page.getByTestId("timestamp").textContent();
    expect(Number(tsText)).toBeGreaterThan(0);
  });
});

// https://github.com/vercel/next.js/blob/v16.2.7/test/e2e/app-dir/custom-cache-control/custom-cache-control.test.ts
for (const scenario of ["short-browser", "long-browser", "no-store", "gssp"]) {
  test(`development browser cache policy: ${scenario}`, async ({ baseURL, request }) => {
    const response = await request.get(`${baseURL}/storage-policy/${scenario}`);
    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toBe("no-cache, must-revalidate");
    const html = await response.text();
    const data = JSON.parse(
      html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)![1],
    );
    const dataURL = `${baseURL}/_next/data/${data.buildId}/storage-policy/${scenario}.json`;
    for (const url of [`${baseURL}/storage-policy/${scenario}`, dataURL]) {
      for (const method of ["GET", "HEAD"]) {
        const result = await request.fetch(url, { method });
        expect(result.status()).toBe(200);
        expect(result.headers()["cache-control"]).toBe("no-cache, must-revalidate");
      }
    }
  });
}
