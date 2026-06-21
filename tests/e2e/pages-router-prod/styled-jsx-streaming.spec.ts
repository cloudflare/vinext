import { expect, test } from "@playwright/test";

test("renders late and external styled-jsx CSS in production Pages SSR", async ({ request }) => {
  const response = await request.get("http://localhost:4175/styled-jsx-streaming");
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
