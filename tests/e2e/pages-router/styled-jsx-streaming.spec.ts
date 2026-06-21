import { expect, test } from "../fixtures";

test("renders late and external styled-jsx CSS in streamed Pages SSR", async ({
  request,
  baseURL,
}) => {
  // Ported from Next.js: test/e2e/streaming-ssr/index.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/streaming-ssr/index.test.ts
  const response = await request.get(`${baseURL}/styled-jsx-streaming`);
  expect(response.status()).toBe(200);

  const html = await response.text();
  expect(html).toMatch(/color:(?:blue|#00f)/);
  expect(html).toMatch(/color:(?:hotpink|#ff69b4)/);
  expect(html).toMatch(/background:(?:yellow|#ff0)/);
  expect(html).toContain('id="late-styled-content"');
  expect(html).toMatch(/class="[^"]*jsx-[^"]+ external[^"]*"/);
  expect(html).not.toContain("<style jsx");
  const lateStyleIndex = html.lastIndexOf("<style");
  expect(html.lastIndexOf("</div>")).toBeLessThan(lateStyleIndex);
  expect(html.indexOf("<script", lateStyleIndex)).toBeGreaterThan(lateStyleIndex);
});

test("hydrates streamed styled-jsx outside the React root without warnings", async ({
  page,
  baseURL,
  consoleErrors,
}) => {
  await page.goto(`${baseURL}/styled-jsx-streaming`);
  await expect(page.locator("#late-styled-content")).toBeVisible();
  await expect(page.locator("#__next > style")).toHaveCount(0);
  await expect(page.locator("body > style")).not.toHaveCount(0);
  void consoleErrors;
});
