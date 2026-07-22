import { test, expect } from "@playwright/test";

test("dev mode self-hosts Google fonts", async ({ page, request }) => {
  await page.goto("/font-google-test");
  const html = await page.content();
  expect(html).not.toContain("fonts.googleapis.com");
  expect(html).toMatch(/<style data-vinext-fonts/);

  const m = html.match(/href="(\/[^"]*_vinext_fonts\/[^"]+\.woff2)"/);
  expect(m).not.toBeNull();
  const res = await request.get(m![1]);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toBe("font/woff2");
  expect((await res.body()).byteLength).toBeGreaterThan(1000);
});
